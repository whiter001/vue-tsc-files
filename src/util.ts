import { writeFileSync, unlinkSync, existsSync, statSync, readFileSync } from "fs";
import { dirname, join, resolve, relative } from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import type tsTypes from "typescript";
import type { TSConfig } from "@json-types/tsconfig";

/**
 * Creates require functions anchored at process.cwd() first and at this
 * bundle second. dlx/npx 场景下 bundle 位于临时沙箱，从自身位置解析拿到的
 * 是沙箱自动安装的 peer 副本，版本可能与项目不符；优先 cwd 才能命中项目
 * 自己安装的版本。正常 devDependency 场景两个锚点解析结果相同。
 */
export function createResolverRequires(): NodeRequire[] {
  return [
    createRequire(pathToFileURL(join(process.cwd(), "vue-tsc-files.js"))),
    createRequire(import.meta.url),
  ];
}

function loadTypescript(): typeof tsTypes {
  for (const req of createResolverRequires()) {
    try {
      return req("typescript") as typeof tsTypes;
    } catch {
      // 尝试下一个锚点
    }
  }
  console.error("Cannot find typescript. Please install it first, e.g. `npm i -D typescript`.");
  process.exit(1);
}

let cachedTypescript: typeof tsTypes | undefined;
function getTypescript(): typeof tsTypes {
  return (cachedTypescript ??= loadTypescript());
}

/** 只让指定文件自身的 error 影响退出码的开关（--changed-only 为别名） */
const ERRORS_IN_CHANGED_ONLY_FLAGS = new Set(["--errors-in-changed-only", "--changed-only"]);

/** 从 git 工作区收集变更文件的开关 */
const CHANGED_FLAG = "--changed";

/** 只收集已暂存（git index）文件的开关 */
const STAGED_FLAG = "--staged";

/** 只收集未暂存（worktree 相对 index 的改动）文件的开关 */
const UNSTAGED_FLAG = "--unstaged";

const HELP_FLAGS = new Set(["-h", "--help"]);

const HELP_TEXT = `vue-tsc-files — run vue-tsc on specific files without ignoring tsconfig.json

Usage:
  vue-tsc-files [flags] <files...>
  vue-tsc-files [--changed | --staged | --unstaged] [flags]

File collection:
  <files...>                  .vue/.ts/.tsx/.mts/.cts files, resolved against the
                              current working directory (absolute paths also work)
  --changed                   Collect changed files from git status
                              (staged + unstaged + untracked)
  --staged                    Collect only staged files (the git index).
                              Note: files are selected by the index but their
                              current on-disk content is type-checked
  --unstaged                  Collect only unstaged changes to tracked files
                              (git diff; untracked files are not included)

Flags:
  -p, --project <path>        Use a specific tsconfig.json (--project=<path> also works)
  --errors-in-changed-only    Only errors in the specified files (plus global
                              config errors) affect the exit code; errors in
                              transitively compiled files are printed but ignored
  --changed-only              Alias for --errors-in-changed-only
  -h, --help                  Show this help

File arguments and the collection flags can be mixed; the union is checked.
--noEmit is always passed to vue-tsc; other compiler flags are forwarded.
Response-file arguments (@file) are not supported; pass arguments directly.
Ambiguous forwarding that changes option meaning is rejected; use explicit values.
If incremental/composite is effectively enabled, the buildinfo cache is redirected
to a per-run temporary file — your configured or CLI-passed cache is never touched —
and removed together with the temporary tsconfig after the check.
`;

export function setupArgs() {
  const args = process.argv.slice(2);

  let errorsInChangedOnly = false;
  let changed = false;
  let staged = false;
  let unstaged = false;
  let projectValue: string | undefined;

  // project 在解析上下文中保留边界，但不转发给子进程。
  const rest: string[] = [];
  const projectIndices = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (HELP_FLAGS.has(arg)) {
      console.log(HELP_TEXT);
      process.exit(0);
    }
    const lower = arg.toLowerCase();
    if (lower === "-p" || lower === "--p" || lower === "-project" || lower === "--project") {
      const value = args[i + 1];
      if (value === undefined) {
        console.error(`${arg} requires a tsconfig path argument.`);
        process.exit(1);
      }
      projectValue = value;
      projectIndices.add(rest.length);
      projectIndices.add(rest.length + 1);
      rest.push("--project", value);
      i++;
      continue;
    }
    if (
      lower.startsWith("-p=") ||
      lower.startsWith("--p=") ||
      lower.startsWith("-project=") ||
      lower.startsWith("--project=")
    ) {
      projectValue = arg.slice(arg.indexOf("=") + 1);
      if (!projectValue) {
        console.error(`${arg} requires a non-empty tsconfig path.`);
        process.exit(1);
      }
      projectIndices.add(rest.length);
      projectIndices.add(rest.length + 1);
      rest.push("--project", projectValue);
      continue;
    }
    if (ERRORS_IN_CHANGED_ONLY_FLAGS.has(arg)) {
      errorsInChangedOnly = true;
      continue;
    }
    if (arg === CHANGED_FLAG) {
      changed = true;
      continue;
    }
    if (arg === STAGED_FLAG) {
      staged = true;
      continue;
    }
    if (arg === UNSTAGED_FLAG) {
      unstaged = true;
      continue;
    }
    rest.push(arg);
  }

  if (rest.some((arg, index) => !projectIndices.has(index) && arg.startsWith("@"))) {
    console.error("Response-file arguments (@file) are not supported; pass arguments directly.");
    process.exit(1);
  }

  const sourceIndices: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (!projectIndices.has(i) && !rest[i]!.startsWith("-") && isTscFile(rest[i]!)) {
      sourceIndices.push(i);
    }
  }

  // git 收集不加载 TS
  const gitFiles: string[] = [];
  const collectors = [
    [changed, getChangedFiles],
    [staged, getStagedFiles],
    [unstaged, getUnstagedFiles],
  ] as const;
  for (const [enabled, collect] of collectors) {
    if (!enabled) continue;
    for (const file of collect()) {
      gitFiles.push(file);
    }
  }

  const resolvedSources = new Set(sourceIndices);
  if (sourceIndices.length > 0 && rest.some((arg) => arg.startsWith("-"))) {
    // 用位置标记区分同名文件和 option 值，并保留 project 对 list option 的边界。
    const prefix = `__vue_tsc_files_${randomChars()}_`;
    const markedArgs = rest.map((arg, index) =>
      resolvedSources.has(index) ? `${prefix}${index}.ts` : arg,
    );
    const fileNames = new Set(getTypescript().parseCommandLine(markedArgs).fileNames);
    for (const index of sourceIndices) {
      if (!fileNames.has(markedArgs[index]!)) {
        resolvedSources.delete(index);
      }
    }
  }

  const seen = new Set([...resolvedSources].map((index) => rest[index]!));
  for (const file of gitFiles) {
    seen.add(file);
  }
  const remainingArgsToForward = rest.filter(
    (_, index) => !projectIndices.has(index) && !resolvedSources.has(index),
  );

  const specifiedFiles = [...seen];

  if (specifiedFiles.length > 0 && rest.some((arg) => arg.startsWith("-"))) {
    const ts = getTypescript();
    const original = ts.parseCommandLine(rest).options;
    const forwarded = ts.parseCommandLine([...remainingArgsToForward, "--noEmit"]).options;
    const keys = new Set([...Object.keys(original), ...Object.keys(forwarded)]);
    keys.delete("project");
    keys.delete("noEmit");
    if (
      forwarded.noEmit !== true ||
      [...keys].some((key) => JSON.stringify(original[key]) !== JSON.stringify(forwarded[key]))
    ) {
      console.error("Cannot safely forward compiler options: provide explicit option values.");
      process.exit(1);
    }
  }

  if (specifiedFiles.length === 0) {
    if (changed || staged || unstaged) {
      const source = changed ? "changed" : staged ? "staged" : "unstaged";
      console.log(`No ${source} files to type-check`);
      process.exit(0);
    }
    // 用法错误不能静默 exit 0，否则 CI 门禁假绿
    console.error(
      "No files to check: pass .vue/.ts/.tsx/.mts/.cts files, or use --changed/--staged/--unstaged.",
    );
    process.exit(1);
  }

  const files = [...specifiedFiles];

  return {
    files,
    specifiedFiles,
    errorsInChangedOnly,
    changed,
    staged,
    unstaged,
    projectValue,
    remainingArgsToForward,
  };
}
/** 临时 tsconfig 使用 16 位小写十六进制随机后缀。 */
export function randomChars() {
  return randomBytes(8).toString("hex");
}

/** 沿 extends 解析选项，并仅收集项目 include/exclude/files 范围内的 .d.ts。 */
// `ts` 是运行时加载的值绑定，不能用于限定类型名；类型位置走类型专用导入
function getParsedProjectConfig(tsconfigPath: string): tsTypes.ParsedCommandLine | undefined {
  const ts = getTypescript();
  return ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, {
    ...ts.sys,
    // 配置文件此前已成功读取，这里不会再触发不可恢复诊断
    onUnRecoverableConfigFileDiagnostic: () => {},
  });
}

/** 扩展名忽略大小写，避免漏掉 git 报告的 Foo.TS / Bar.Vue 等路径。 */
export function isTscFile(arg: string) {
  const lower = arg.toLowerCase();
  return (
    lower.endsWith(".vue") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  );
}

export function getTscFiles(args: string[]) {
  return args.filter(isTscFile);
}

/**
 * 解析 git status --porcelain=v1 -z，路径相对仓库根目录。
 * 条目为 "XY path\0"；R/C 后的旧路径需跳过，纯删除状态不参与检查。
 */
export function parseGitStatusPorcelain(output: string): string[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (/[MARCU?]/.test(status)) {
      paths.push(path);
    }
    if (/[RC]/.test(status)) {
      // 重命名/复制的第二个条目是旧路径，只检查新路径
      i++;
    }
  }
  return paths;
}

/** git 子进程的超时上限，避免 CI 资源紧张或 git 卡死时 CLI 无期限挂起 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Runs a git command and returns its stdout, exiting with a clear message on
 * failure or timeout. maxBuffer 放宽到 64MB：未忽略文件多的大仓库下
 * `git status -uall -z` 输出可能超过默认 1MB 上限导致子进程被杀。
 */
function runGit(args: string[], failureHint: string): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    console.error(
      `git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s. ` +
        "The repository may be very large or git may be stuck; retry or check git status manually.",
    );
    process.exit(1);
  }
  if (result.error || result.status !== 0) {
    console.error(`${failureHint}: ${result.stderr || result.error}`);
    process.exit(1);
  }
  return result.stdout;
}

/**
 * Returns the absolute path of the git repository root. 缓存在模块级：
 * --changed/--staged/--unstaged 混用时不必重复 spawn git rev-parse。
 */
let cachedRepoRoot: string | undefined;
function getRepoRoot(): string {
  if (!cachedRepoRoot) {
    cachedRepoRoot = runGit(
      ["rev-parse", "--show-toplevel"],
      "Failed to locate the git repository root. --changed/--staged/--unstaged must be used inside a git repository",
    ).trim();
  }
  return cachedRepoRoot;
}

/**
 * Converts repository-root-relative git paths to cwd-relative ones and drops
 * entries that must never be type-checked. 未跟踪的 node_modules 在 -uall
 * 下会逐文件展开，可能产生几十万行输出；正解是 .gitignore，这里兜底直接
 * 丢弃（依赖文件本就不该参与检查）。已不存在的文件（如冲突状态 DU/UD 中
 * 一侧已删除）同样剔除，否则 vue-tsc 的 "file not found" 会被归为全局
 * 错误导致误失败。
 */
function toCheckableFiles(repoRoot: string, gitPaths: string[]): string[] {
  return gitPaths
    .map((path) => relative(process.cwd(), resolve(repoRoot, path)))
    .filter((path) => !path.split(/[\\/]/).includes("node_modules"))
    .filter(isTscFile)
    .filter((path) => existsSync(resolve(process.cwd(), path)));
}

/**
 * status 的 XY 两列覆盖 index/worktree 变更（含未合并），-uall 展开未跟踪目录。
 * -- . 限定当前目录范围；返回 cwd 相对路径，支持从仓库子目录运行。
 */
export function getChangedFiles(): string[] {
  const repoRoot = getRepoRoot();
  const statusOutput = runGit(
    ["status", "--porcelain=v1", "-z", "-uall", "--", "."],
    "git status failed",
  );
  return toCheckableFiles(repoRoot, parseGitStatusPorcelain(statusOutput));
}

function getDiffFiles(cached: boolean): string[] {
  const repoRoot = getRepoRoot();
  // --name-only 只保留重命名的新路径；ACMRT 排除删除和未合并文件。
  const diffOutput = runGit(
    [
      "diff",
      ...(cached ? ["--cached"] : []),
      "--name-only",
      "-z",
      "--diff-filter=ACMRT",
      "--",
      ".",
    ],
    cached ? "git diff --cached failed" : "git diff failed",
  );
  return toCheckableFiles(repoRoot, diffOutput.split("\0").filter(Boolean));
}

/** 按 index 选择已暂存文件，但类型检查仍读取当前磁盘内容。 */
export function getStagedFiles(): string[] {
  return getDiffFiles(true);
}

/** worktree 相对 index 的改动，不含未跟踪文件（需用 --changed）。 */
export function getUnstagedFiles(): string[] {
  return getDiffFiles(false);
}

/** 使用 TS 配置读取器支持注释、尾逗号，并为非法配置提供诊断。 */
function getRootTsConfig(tsconfigPath: string): TSConfig {
  const ts = getTypescript();
  const result = ts.readConfigFile(tsconfigPath, ts.sys.readFile);

  if (result.error) {
    const message = ts.flattenDiagnosticMessageText(result.error.messageText, "\n");
    console.error(`Failed to read ${tsconfigPath}: ${message}`);
    process.exit(1);
  }

  return result.config as TSConfig;
}

/** 临时配置与原配置同目录，保持 extends/baseUrl/paths/typeRoots 的相对路径语义。 */
function createTmpTsConfig(
  rootTsConfig: TSConfig,
  files: string[],
  configDir: string,
  userSkipLibCheck?: boolean,
  manageBuildInfo?: boolean,
) {
  // buildinfo 与 tmp 配置共用随机后缀：独占临时、不污染用户缓存，CLI 也能由 tmp 路径推导出它
  const suffix = randomChars();
  const tmpTsconfigPath = join(configDir, `tsconfig.${suffix}.json`);
  const buildInfoPath = manageBuildInfo
    ? join(configDir, `tsconfig.${suffix}.tsbuildinfo`)
    : undefined;
  const tmpTsconfig = {
    ...rootTsConfig,
    compilerOptions: {
      // 默认开启 skipLibCheck 加速检查；用户显式配置（含 extends 继承值）优先。
      ...(userSkipLibCheck === undefined ? { skipLibCheck: true } : {}),
      ...rootTsConfig.compilerOptions,
      ...(buildInfoPath ? { tsBuildInfoFile: buildInfoPath } : {}),
    },
    // files 按 tmp tsconfig 所在目录解析，统一写成绝对路径，
    // 避免 -p 指向子目录 tsconfig 时 cwd 相对路径错位
    files: files.map((file) => resolve(process.cwd(), file)),
    include: [],
  };
  writeFileSync(tmpTsconfigPath, JSON.stringify(tmpTsconfig, null, 2));

  registerCleanupHandler(tmpTsconfigPath);
  if (buildInfoPath) registerCleanupHandler(buildInfoPath);

  return tmpTsconfigPath;
}

/** 信号对应的退出码（128 + 信号值），与 shell 约定一致 */
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const;

/** 待清理的临时产物路径（临时 tsconfig / 独占 buildinfo）；监听器全局只注册一次，避免多次调用累积 listener */
const tmpArtifactPaths = new Set<string>();
let cleanupHandlersRegistered = false;

function registerCleanupHandler(artifactPath: string) {
  tmpArtifactPaths.add(artifactPath);
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;

  const cleanup = () => {
    for (const path of tmpArtifactPaths) {
      try {
        unlinkSync(path);
      } catch {
        // 临时文件可能已被清理，忽略
      }
    }
  };

  process.on("exit", cleanup);
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    // 信号回调没有参数，需显式设置退出码，避免把中断误报为通过。
    process.on(signal, () => {
      cleanup();
      process.exit(SIGNAL_EXIT_CODES[signal]);
    });
  }
}

/** 声明文件扩展名：.d.ts/.d.mts/.d.cts（忽略大小写，对齐 isTscFile 的语义）。 */
function isDeclarationFileName(name: string) {
  return /\.d\.[cm]?ts$/i.test(name);
}

/**
 * buildinfo 是否应由本次运行独占接管：incremental/composite 生效即可。
 * 两项各自 CLI 覆盖配置后取或，composite 不因 incremental:false 被屏蔽。
 * 无有效 incremental 时不接管，避免向 tsc 注入未启用 incremental 的缓存选项。
 */
function shouldManageBuildInfo(
  parsed: tsTypes.ParsedCommandLine | undefined,
  remainingArgsToForward: string[],
) {
  const forwarded = getTypescript().parseCommandLine(remainingArgsToForward).options;
  return Boolean(
    (forwarded.incremental ?? parsed?.options.incremental) ||
    (forwarded.composite ?? parsed?.options.composite),
  );
}

export function createAndSetupTsConfig(
  files: string[],
  argsProjectValue?: string,
  remainingArgsToForward: string[] = [],
) {
  let tsconfigPath = argsProjectValue
    ? resolve(process.cwd(), argsProjectValue)
    : resolve(process.cwd(), "tsconfig.json");
  // 对齐 tsc 的 -p 语义：传目录时读取其中的 tsconfig.json；
  // 目录里没有 tsconfig.json 时不特殊处理，让读取失败的报错自然发生
  if (statSync(tsconfigPath, { throwIfNoEntry: false })?.isDirectory()) {
    tsconfigPath = join(tsconfigPath, "tsconfig.json");
  }
  const rootTsConfig = getRootTsConfig(tsconfigPath);
  const parsed = getParsedProjectConfig(tsconfigPath);

  // 原配置的解析错误在生成 tmp/覆盖 buildinfo 之前报出：compilerOptions/extends 等错误
  // 不能被 override 抹掉，落点可能是 .ts 文件，也不该交给依赖豁免过滤。
  // 无输入（18002/18003）除外：files/include 会被 wrapper 替换，solution 式
  // files:[]+references、显式文件在原 include 之外都合法
  const configErrors = (parsed?.errors ?? []).filter(
    (diagnostic) => diagnostic.code !== 18002 && diagnostic.code !== 18003,
  );
  if (configErrors.length > 0) {
    const ts = getTypescript();
    process.stderr.write(
      ts.formatDiagnostics(configErrors, {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (fileName: string) => fileName,
        getNewLine: () => "\n",
      }),
    );
    process.exit(2);
  }

  const dtsFiles = parsed?.fileNames.filter(isDeclarationFileName) ?? [];

  // @json-types/tsconfig 的 TSConfig 不含 references 字段，按结构类型探测
  const references = (rootTsConfig as { references?: unknown[] }).references;
  if (Array.isArray(references) && references.length > 0) {
    console.error(
      "Note: this tsconfig uses project references; they are kept in the generated config " +
        "but referenced projects are not built automatically. Pre-build referenced projects " +
        "first — their .d.ts outputs may be required for the check.",
    );
  }

  // 生效时 buildinfo 走独占临时文件；判定见 shouldManageBuildInfo
  const manageBuildInfo = shouldManageBuildInfo(parsed, remainingArgsToForward);

  return createTmpTsConfig(
    rootTsConfig,
    [...files, ...dtsFiles],
    dirname(tsconfigPath),
    parsed?.options.skipLibCheck,
    manageBuildInfo,
  );
}

/** 与临时 tsconfig 同随机后缀的 companion buildinfo 路径（仅后缀名不同）。 */
function getCompanionBuildInfoPath(tmpTsconfigPath: string) {
  return tmpTsconfigPath.replace(/\.json$/, ".tsbuildinfo");
}

/**
 * CLI 需在 forwarded args 之后追加的内部 --tsBuildInfoFile 值：命令行重复选项
 * 后者覆盖前者，用户配置或显式传入的缓存路径因此不会被写入；未接管时返回 undefined。
 */
export function getInternalTsBuildInfoFile(tmpTsconfigPath: string): string | undefined {
  const expected = getCompanionBuildInfoPath(tmpTsconfigPath);
  try {
    const compilerOptions = (JSON.parse(readFileSync(tmpTsconfigPath, "utf8")) as TSConfig)
      .compilerOptions as { tsBuildInfoFile?: unknown } | undefined;
    return compilerOptions?.tsBuildInfoFile === expected ? expected : undefined;
  } catch {
    return undefined;
  }
}

/** 带位置信息的诊断行，如 src/a.ts(12,5): error TS2322: ... */
const LOCATED_ERROR_RE = /^(.+?)\(\d+,\d+\): error TS\d+:/;
/** --pretty 输出中带位置信息的诊断行，如 src/a.ts:12:5 - error TS2322: ... */
const PRETTY_LOCATED_ERROR_RE = /^(.+?):\d+:\d+ - error TS\d+:/;
/** 不带文件位置的全局错误，如 error TS5083: Cannot read file ... */
const GLOBAL_ERROR_RE = /^error TS\d+:/;

// oxlint-disable-next-line no-control-regex -- 匹配 ANSI SGR 序列必须包含 ESC 控制符
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

/**
 * Removes ANSI SGR color/style sequences. --pretty 转给 tsc 后诊断行的
 * "error TSxxxx:" 本身也带色码，不去除会让所有正则归属判断失效。
 */
export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/**
 * Normalizes a diagnostic file path for comparison with the specified files.
 * tsc prints paths relative to the current working directory; both sides are
 * resolved to absolute paths so "./a.ts" and "a.ts" compare equal.
 * 防御性去掉首尾单引号：tsc 当前不会对含空格的路径加引号，但部分
 * pretty 输出/第三方 formatter 会（如 'foo bar.ts'(1,1): error ...）。
 * Windows 文件系统不区分大小写，统一转小写。
 */
function normalizeDiagnosticPath(filePath: string): string {
  const unquoted = filePath.replace(/^'|'$/g, "");
  const absolute = resolve(process.cwd(), unquoted).replace(/\\/g, "/");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export interface ErrorFilterResult {
  /** 指定文件自身的错误行 */
  errorsInSpecifiedFiles: string[];
  /** 全局错误：无位置的错误行，及落在临时配置/非受支持源文件上的诊断；出现即视为失败 */
  globalErrors: string[];
}

/**
 * 从合并的 stdout/stderr 收集指定文件和全局错误，忽略传递依赖错误。
 * specifiedFiles 仅含显式参数和 Git 收集文件；自动补入的声明文件不参与归属。
 * 落在临时配置上的诊断（配置错误，含 extends 链上报的 base.json/jsonc）以及落在
 * 非受支持源文件（.json/.jsonc 等，含 JSON module）上的 TS 错误保守归为全局错误：
 * 这些不是"传递依赖"的豁免对象。传了 tmpTsconfigPath 时临时配置自身的诊断也归全局。
 */
export function filterErrorsInFiles(
  output: string,
  specifiedFiles: string[],
  tmpTsconfigPath?: string,
): ErrorFilterResult {
  const targets = new Set(specifiedFiles.map(normalizeDiagnosticPath));
  const tmpConfigTarget =
    tmpTsconfigPath === undefined ? undefined : normalizeDiagnosticPath(tmpTsconfigPath);
  const errorsInSpecifiedFiles: string[] = [];
  const globalErrors: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = stripAnsiCodes(line).trim();
    const located = LOCATED_ERROR_RE.exec(trimmed) ?? PRETTY_LOCATED_ERROR_RE.exec(trimmed);
    if (located) {
      const filePath = normalizeDiagnosticPath(located[1]!);
      if (targets.has(filePath)) {
        errorsInSpecifiedFiles.push(line);
        continue;
      }
      // 临时配置路径上的配置诊断、以及非受支持源文件上的 TS 错误，保守归全局
      if (filePath === tmpConfigTarget || !isTscFile(filePath)) {
        globalErrors.push(line);
      }
      continue;
    }
    if (GLOBAL_ERROR_RE.test(trimmed)) {
      globalErrors.push(line);
    }
  }

  return { errorsInSpecifiedFiles, globalErrors };
}

export function getDiagnosticExitResult(
  status: number | null,
  output: string,
  specifiedFiles: string[],
  tmpTsconfigPath?: string,
): { exitCode: number; ignoredDependencyErrors: boolean } {
  // status 为 null 说明子进程被信号中断或异常崩溃：输出再"像"依赖错误也不能信，
  // 配置诊断同样不可按依赖豁免，一律按失败处理。
  if (status === null) {
    return { exitCode: 1, ignoredDependencyErrors: false };
  }
  if (status === 0) return { exitCode: 0, ignoredDependencyErrors: false };
  // --noEmit 的正常类型诊断退出码是 2；Windows 中断可能只表现为 status 1。
  if (status !== 2) return { exitCode: status, ignoredDependencyErrors: false };

  const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(
    output,
    specifiedFiles,
    tmpTsconfigPath,
  );
  if (errorsInSpecifiedFiles.length > 0 || globalErrors.length > 0) {
    return { exitCode: status, ignoredDependencyErrors: false };
  }
  // 非零退出却没有可识别诊断（如 vue-tsc 崩溃），保守按失败处理。
  if (!/error TS\d+:/.test(stripAnsiCodes(output))) {
    return { exitCode: status, ignoredDependencyErrors: false };
  }
  return { exitCode: 0, ignoredDependencyErrors: true };
}
