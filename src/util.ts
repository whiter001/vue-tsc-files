import { readdirSync, lstatSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import ts from "typescript";
import { type TSConfig } from "@json-types/tsconfig";

/** 只让指定文件自身的 error 影响退出码的开关（--changed-only 为别名） */
const ERRORS_IN_CHANGED_ONLY_FLAGS = new Set(["--errors-in-changed-only", "--changed-only"]);

/**
 * Sets up the arguments for vue-tsc.
 *
 * @returns An object containing the files, project value, and remaining arguments to forward.
 */
export function setupArgs() {
  const args = process.argv.slice(2);

  const files = getFiles(args);
  const specifiedFiles = getTscFiles(args);
  let errorsInChangedOnly = false;

  // 单次遍历同时剔除文件参数和 -p/--project 及其值。
  // 不能先过滤文件再按原始索引 splice：文件参数出现在 -p 之前时索引会错位，
  // 导致残留的 -p 被转发给 vue-tsc 并与内部传入的 -p 冲突。
  let projectValue: string | undefined;
  const remainingArgsToForward: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--project") {
      projectValue = args[i + 1];
      i++;
      continue;
    }
    if (ERRORS_IN_CHANGED_ONLY_FLAGS.has(arg)) {
      errorsInChangedOnly = true;
      continue;
    }
    if (files.includes(arg)) {
      continue;
    }
    remainingArgsToForward.push(arg);
  }

  return {
    files,
    specifiedFiles,
    errorsInChangedOnly,
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

/** 扫描 d.ts 时跳过的目录：依赖、VCS 元数据和常见构建产物目录 */
const DTS_SCAN_IGNORED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

/**
 * Retrieves an array of .d.ts files recursively from the specified directory.
 * Dot directories (.git, .github, ...) and common build outputs are skipped
 * to avoid wasted IO and duplicate declarations from generated files.
 *
 * @param dir - The directory to search for .d.ts files.
 * @returns An array of .d.ts file paths.
 */
export function getDtsFiles(dir: string): string[] {
  const files = readdirSync(dir);
  return files.reduce<string[]>((acc: string[], file: string) => {
    const path = `${dir}/${file}`;
    const isDirectory = lstatSync(path).isDirectory();
    if (isDirectory) {
      if (file.startsWith(".") || DTS_SCAN_IGNORED_DIRS.has(file)) {
        return acc;
      }
      return [...acc, ...getDtsFiles(path)];
    }
    if (path.endsWith(".d.ts")) {
      return [...acc, path];
    }
    return acc;
  }, []);
}

/**
 * Filters the given array of arguments and returns an array of files with specific extensions.
 * @param args - The array of arguments to filter.
 * @returns An array of files with extensions ".vue", ".ts", ".tsx", ".mts" or ".cts".
 */
export function getTscFiles(args: string[]) {
  return args.filter(
    (arg) =>
      arg.endsWith(".vue") ||
      arg.endsWith(".ts") ||
      arg.endsWith(".tsx") ||
      arg.endsWith(".mts") ||
      arg.endsWith(".cts"),
  );
}

/**
 * Retrieves a list of files to be processed based on the provided arguments.
 *
 * @param args - The arguments passed to the program.
 * @returns An array of file paths to be processed.
 */
export function getFiles(args: string[]): string[] {
  const tscFiles = getTscFiles(args);

  if (tscFiles.length == 0) {
    process.exit(0);
  }

  const dtsFiles = getDtsFiles(process.cwd());

  return [...tscFiles, ...dtsFiles];
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
 * @param argsProjectValue - Optional path to a specific tsconfig.json file.
 * @returns The parsed TSConfig object.
 */
function getRootTsConfig(argsProjectValue?: string): TSConfig {
  const tsconfigPath = argsProjectValue || resolveFromRoot("tsconfig.json");
  const result = ts.readConfigFile(tsconfigPath, ts.sys.readFile);

  if (result.error) {
    const message = ts.flattenDiagnosticMessageText(result.error.messageText, "\n");
    console.error(`Failed to read ${tsconfigPath}: ${message}`);
    process.exit(1);
  }

  return result.config as TSConfig;
}

/**
 * Creates a temporary TypeScript configuration file.
 * @param rootTsConfig The root TypeScript configuration.
 * @param files The list of files to include in the temporary configuration.
 * @returns The path of the created temporary TypeScript configuration file.
 */
function createTmpTsConfig(rootTsConfig: TSConfig, files: string[]) {
  const tmpTsconfigPath = resolveFromRoot(`tsconfig.${randomChars()}.json`);
  const tmpTsconfig = {
    ...rootTsConfig,
    compilerOptions: {
      ...rootTsConfig.compilerOptions,
      skipLibCheck: true,
    },
    files,
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
  const rootTsConfig = getRootTsConfig(argsProjectValue);
  const tmpTsconfigPath = createTmpTsConfig(rootTsConfig, files);

  return tmpTsconfigPath;
}

/** 带位置信息的诊断行，如 src/a.ts(12,5): error TS2322: ... */
const LOCATED_ERROR_RE = /^(.+?)\(\d+,\d+\): error TS\d+:/;
/** 不带文件位置的全局错误，如 error TS5083: Cannot read file ... */
const GLOBAL_ERROR_RE = /^error TS\d+:/;

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
    const trimmed = line.trim();
    const located = LOCATED_ERROR_RE.exec(trimmed);
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
