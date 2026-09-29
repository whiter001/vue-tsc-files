import { writeFileSync, unlinkSync } from "fs";
import { dirname, join, resolve, relative } from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import ts from "typescript";
import { type TSConfig } from "@json-types/tsconfig";

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
--noEmit is always passed to vue-tsc; any other flags are forwarded as-is.
`;

/**
 * Sets up the arguments for vue-tsc.
 *
 * @returns An object containing the files, project value, and remaining arguments to forward.
 */
export function setupArgs() {
  const args = process.argv.slice(2);

  const explicitFiles = getTscFiles(args);
  let errorsInChangedOnly = false;
  let changed = false;
  let staged = false;
  let unstaged = false;

  // 单次遍历同时剔除文件参数和 -p/--project 及其值。
  // 不能先过滤文件再按原始索引 splice：文件参数出现在 -p 之前时索引会错位，
  // 导致残留的 -p 被转发给 vue-tsc 并与内部传入的 -p 冲突。
  let projectValue: string | undefined;
  const remainingArgsToForward: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (HELP_FLAGS.has(arg)) {
      // 在任何文件收集和 tsconfig 读取之前生效，保证无 tsconfig 的目录里也能用
      console.log(HELP_TEXT);
      process.exit(0);
    }
    if (arg === "-p" || arg === "--project") {
      const value = args[i + 1];
      if (value === undefined) {
        console.error(`${arg} requires a tsconfig path argument.`);
        process.exit(1);
      }
      projectValue = value;
      i++;
      continue;
    }
    if (arg.startsWith("--project=") || arg.startsWith("-p=")) {
      projectValue = arg.slice(arg.indexOf("=") + 1);
      if (!projectValue) {
        console.error(`${arg} requires a non-empty tsconfig path.`);
        process.exit(1);
      }
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
    if (explicitFiles.includes(arg)) {
      continue;
    }
    remainingArgsToForward.push(arg);
  }

  const specifiedFiles = [...new Set(explicitFiles)];
  if (changed) {
    for (const file of getChangedFiles()) {
      if (!specifiedFiles.includes(file)) {
        specifiedFiles.push(file);
      }
    }
  }
  if (staged) {
    for (const file of getStagedFiles()) {
      if (!specifiedFiles.includes(file)) {
        specifiedFiles.push(file);
      }
    }
  }
  if (unstaged) {
    for (const file of getUnstagedFiles()) {
      if (!specifiedFiles.includes(file)) {
        specifiedFiles.push(file);
      }
    }
  }

  if (specifiedFiles.length === 0) {
    if (changed || staged || unstaged) {
      const source = changed ? "changed" : staged ? "staged" : "unstaged";
      console.log(`No ${source} files to type-check`);
    }
    process.exit(0);
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
/**
 * Generates a random string of characters.
 *
 * @returns {string} The random string of characters.
 */
export function randomChars() {
  return randomBytes(8).toString("hex");
}

/**
 * Collects the project's .d.ts files using the tsconfig's own include/exclude/
 * files scope (extends chains resolved by the TypeScript parser), so global
 * declarations are available without pulling in declarations the project
 * itself would never compile.
 *
 * @param tsconfigPath - The absolute path of the root tsconfig.json.
 * @returns Absolute paths of the .d.ts files in the project's file set.
 */
function getProjectDtsFiles(tsconfigPath: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, {
    ...ts.sys,
    // 配置文件此前已成功读取，这里不会再触发不可恢复诊断
    onUnRecoverableConfigFileDiagnostic: () => {},
  });
  if (!parsed) {
    return [];
  }
  return parsed.fileNames.filter((name) => name.endsWith(".d.ts"));
}

/**
 * Returns whether the argument is a file with a supported extension.
 * @param arg - The argument to check.
 */
export function isTscFile(arg: string) {
  return (
    arg.endsWith(".vue") ||
    arg.endsWith(".ts") ||
    arg.endsWith(".tsx") ||
    arg.endsWith(".mts") ||
    arg.endsWith(".cts")
  );
}

/**
 * Filters the given array of arguments and returns an array of files with specific extensions.
 * @param args - The array of arguments to filter.
 * @returns An array of files with extensions ".vue", ".ts", ".tsx", ".mts" or ".cts".
 */
export function getTscFiles(args: string[]) {
  return args.filter(isTscFile);
}

/**
 * Parses `git status --porcelain=v1 -z` output into changed file paths.
 * -z 格式下每个条目为 "XY path\0"；重命名/复制条目（XY 含 R/C）紧随其后
 * 还有一个旧路径条目，跳过它只保留新路径。已删除的文件（D）不参与检查。
 *
 * @param output - The raw stdout of git status.
 * @returns Changed file paths relative to the repository root.
 */
export function parseGitStatusPorcelain(output: string): string[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i].slice(0, 2);
    const path = tokens[i].slice(3);
    if (/[RC]/.test(status)) {
      if (/[MARCU?]/.test(status)) {
        paths.push(path);
      }
      // 重命名/复制的第二个条目是旧路径，已删除不再检查
      i++;
      continue;
    }
    if (/[MARCU?]/.test(status)) {
      paths.push(path);
    }
  }
  return paths;
}

/** git 子进程的超时上限，避免 CI 资源紧张或 git 卡死时 CLI 无期限挂起 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Runs a git command and returns its stdout, exiting with a clear message on
 * failure or timeout.
 */
function runGit(args: string[], failureHint: string): string {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
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
 * Returns the absolute path of the git repository root.
 */
function getRepoRoot(): string {
  return runGit(
    ["rev-parse", "--show-toplevel"],
    "Failed to locate the git repository root. --changed/--staged/--unstaged must be used inside a git repository",
  ).trim();
}

/**
 * Converts repository-root-relative git paths to cwd-relative ones and drops
 * entries that must never be type-checked. 未跟踪的 node_modules 在 -uall
 * 下会逐文件展开，可能产生几十万行输出；正解是 .gitignore，这里兜底直接
 * 丢弃（依赖文件本就不该参与检查）。
 */
function toCheckableFiles(repoRoot: string, gitPaths: string[]): string[] {
  return gitPaths
    .map((path) => relative(process.cwd(), resolve(repoRoot, path)))
    .filter((path) => !path.split(/[\\/]/).includes("node_modules"))
    .filter(isTscFile);
}

/**
 * Collects changed .ts/.tsx/.vue files from the git working tree, equivalent
 * to `git status` semantics: modified, added, renamed, copied, unmerged and
 * untracked files. git status 的 XY 两列同时覆盖已暂存（index）和未暂存
 * （worktree）变更。`-uall` 让 git 直接展开未跟踪目录里的每个文件，
 * 无需自行递归目录。Output paths are made relative to the current working
 * directory so the tool works when run from a repository subdirectory.
 *
 * @returns Changed file paths relative to process.cwd().
 */
export function getChangedFiles(): string[] {
  const repoRoot = getRepoRoot();
  const statusOutput = runGit(
    ["status", "--porcelain=v1", "-z", "-uall", "--", "."],
    "git status failed",
  );
  return toCheckableFiles(repoRoot, parseGitStatusPorcelain(statusOutput));
}

/**
 * Collects only staged .ts/.tsx/.vue files (the git index), i.e. exactly what
 * the next commit would contain — the pre-commit hook semantic. `--name-only`
 * 对重命名只输出新路径；--diff-filter=ACMRT 排除已删除（D）和未合并（U）。
 *
 * @returns Staged file paths relative to process.cwd().
 */
export function getStagedFiles(): string[] {
  const repoRoot = getRepoRoot();
  const diffOutput = runGit(
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT", "--", "."],
    "git diff --cached failed",
  );
  return toCheckableFiles(repoRoot, diffOutput.split("\0").filter(Boolean));
}

/**
 * Collects only unstaged .ts/.tsx/.vue files: tracked files whose worktree
 * content differs from the git index (`git diff` semantic). 未跟踪文件不属于
 * git 的 "unstaged" 概念，不在此收集（需要时请用 --changed）。
 *
 * @returns Unstaged file paths relative to process.cwd().
 */
export function getUnstagedFiles(): string[] {
  const repoRoot = getRepoRoot();
  const diffOutput = runGit(
    ["diff", "--name-only", "-z", "--diff-filter=ACMRT", "--", "."],
    "git diff failed",
  );
  return toCheckableFiles(repoRoot, diffOutput.split("\0").filter(Boolean));
}

/**
 * Resolves a file path relative to the root directory.
 * @param paths - The paths to resolve.
 * @returns The resolved file path.
 */
export function resolveFromRoot(...paths: string[]) {
  return join(process.cwd(), ...paths);
}

/**
 * Retrieves the root tsconfig.json file.
 * Uses the TypeScript compiler's own config reader so comments and trailing
 * commas are supported without eval, and malformed configs produce a proper
 * diagnostic instead of a stack trace.
 *
 * @param tsconfigPath - The resolved path of the tsconfig.json file.
 * @returns The parsed TSConfig object.
 */
function getRootTsConfig(tsconfigPath: string): TSConfig {
  const result = ts.readConfigFile(tsconfigPath, ts.sys.readFile);

  if (result.error) {
    const message = ts.flattenDiagnosticMessageText(result.error.messageText, "\n");
    console.error(`Failed to read ${tsconfigPath}: ${message}`);
    process.exit(1);
  }

  return result.config as TSConfig;
}

/**
 * Creates a temporary TypeScript configuration file next to the original
 * tsconfig, so relative `extends`, `baseUrl`, `paths`, `typeRoots` etc.
 * resolve against the same directory as the user's config.
 * @param rootTsConfig The root TypeScript configuration.
 * @param files The list of files to include in the temporary configuration.
 * @param configDir The directory the original tsconfig lives in.
 * @returns The path of the created temporary TypeScript configuration file.
 */
function createTmpTsConfig(rootTsConfig: TSConfig, files: string[], configDir: string) {
  const tmpTsconfigPath = join(configDir, `tsconfig.${randomChars()}.json`);
  const tmpTsconfig = {
    ...rootTsConfig,
    compilerOptions: {
      // 默认开启 skipLibCheck 加速检查；用户显式配置（true/false）优先
      skipLibCheck: true,
      ...rootTsConfig.compilerOptions,
    },
    // files 按 tmp tsconfig 所在目录解析，统一写成绝对路径，
    // 避免 -p 指向子目录 tsconfig 时 cwd 相对路径错位
    files: files.map((file) => resolve(process.cwd(), file)),
    include: [],
  };
  writeFileSync(tmpTsconfigPath, JSON.stringify(tmpTsconfig, null, 2));

  registerCleanupHandler(tmpTsconfigPath);

  return tmpTsconfigPath;
}

/** 信号对应的退出码（128 + 信号值），与 shell 约定一致 */
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const;

/**
 * Registers a cleanup handler to remove a temporary tsconfig file.
 *
 * @param tmpTsconfigPath - The path of the temporary tsconfig file.
 */
function registerCleanupHandler(tmpTsconfigPath: string) {
  let didCleanup = false;
  const cleanup = () => {
    if (didCleanup) return;
    didCleanup = true;

    try {
      unlinkSync(tmpTsconfigPath);
    } catch {
      // 临时文件可能已被清理，忽略
    }
  };

  process.on("exit", cleanup);
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    // 信号事件回调没有参数，显式以 128+信号值 退出；
    // 之前直接透传 undefined 会以 0 退出，把中断误报为检查通过
    process.on(signal, () => {
      cleanup();
      process.exit(SIGNAL_EXIT_CODES[signal]);
    });
  }
}
/**
 * Creates a temporary TypeScript configuration file and returns its path.
 *
 * @param files - An array of file paths to include in the temporary tsconfig file.
 * @param argsProjectValue - Optional. The value of the --project argument.
 * @returns The path of the temporary tsconfig file.
 */
export function createAndSetupTsConfig(files: string[], argsProjectValue?: string) {
  const tsconfigPath = argsProjectValue
    ? resolve(process.cwd(), argsProjectValue)
    : resolveFromRoot("tsconfig.json");
  const rootTsConfig = getRootTsConfig(tsconfigPath);
  const dtsFiles = getProjectDtsFiles(tsconfigPath);
  const tmpTsconfigPath = createTmpTsConfig(
    rootTsConfig,
    [...files, ...dtsFiles],
    dirname(tsconfigPath),
  );

  return tmpTsconfigPath;
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
  /** 不属于任何文件的全局错误（配置错误等），出现即视为失败 */
  globalErrors: string[];
}

/**
 * Splits vue-tsc output into errors belonging to the specified files and
 * global errors. Errors reported in transitively compiled files are ignored:
 * with --errors-in-changed-only they must not affect the exit code.
 *
 * @param output - The combined stdout/stderr of the vue-tsc run.
 * @param specifiedFiles - The files explicitly passed on the command line
 *   (auto-collected d.ts files are excluded, matching the shell wrapper's semantics).
 * @returns The matched error lines, split by kind.
 */
export function filterErrorsInFiles(output: string, specifiedFiles: string[]): ErrorFilterResult {
  const targets = new Set(specifiedFiles.map(normalizeDiagnosticPath));
  const errorsInSpecifiedFiles: string[] = [];
  const globalErrors: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = stripAnsiCodes(line).trim();
    const located = LOCATED_ERROR_RE.exec(trimmed) ?? PRETTY_LOCATED_ERROR_RE.exec(trimmed);
    if (located) {
      if (targets.has(normalizeDiagnosticPath(located[1]))) {
        errorsInSpecifiedFiles.push(line);
      }
      continue;
    }
    if (GLOBAL_ERROR_RE.test(trimmed)) {
      globalErrors.push(line);
    }
  }

  return { errorsInSpecifiedFiles, globalErrors };
}
