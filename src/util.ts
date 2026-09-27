import { readdirSync, lstatSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import ts from "typescript";
import { type TSConfig } from "@json-types/tsconfig";

/**
 * Sets up the arguments for vue-tsc.
 *
 * @returns An object containing the files, project value, and remaining arguments to forward.
 */
export function setupArgs() {
  const args = process.argv.slice(2);

  const files = getFiles(args);

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
    if (files.includes(arg)) {
      continue;
    }
    remainingArgsToForward.push(arg);
  }

  return {
    files,
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
