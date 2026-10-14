#! /usr/bin/env node
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import {
  setupArgs,
  createAndSetupTsConfig,
  createResolverRequires,
  getDiagnosticExitResult,
  getInternalTsBuildInfoFile,
} from "./util.ts";

const { files, specifiedFiles, errorsInChangedOnly, remainingArgsToForward, projectValue } =
  setupArgs();

const tmpTsconfigPath = createAndSetupTsConfig(files, projectValue, remainingArgsToForward);

/**
 * cwd 优先，避免 dlx/npx 命中沙箱 peer 副本；从 package.json 拼 bin 路径，
 * 因为 pnpm 符号链接布局下真实包旁边没有 .bin。
 */
function resolveVueTscEntry(): string {
  const requires = createResolverRequires();
  for (const req of requires) {
    try {
      const packageJsonPath = req.resolve("vue-tsc/package.json");
      return join(dirname(packageJsonPath), "bin", "vue-tsc.js");
    } catch {
      // 尝试下一个锚点
    }
  }
  for (const req of requires) {
    try {
      // vue-tsc 未来版本若添加 exports 且未导出 ./package.json，
      // 回退到直接解析 bin 入口子路径
      return req.resolve("vue-tsc/bin/vue-tsc.js");
    } catch {
      // 尝试下一个锚点
    }
  }
  throw new Error("vue-tsc not found");
}

let vueTscEntry: string;
try {
  vueTscEntry = resolveVueTscEntry();
} catch {
  console.error("Cannot find vue-tsc. Please install it first, e.g. `npm i -D vue-tsc`.");
  process.exit(1);
}

// incremental/composite 生效时，在 forwarded args 之后追加内部 --tsBuildInfoFile：
// 命令行重复选项后者覆盖前者，用户配置或显式传入的缓存路径因此不会被写入
const internalBuildInfoFile = getInternalTsBuildInfoFile(tmpTsconfigPath);
const vueTscArgs = [
  vueTscEntry,
  "-p",
  tmpTsconfigPath,
  ...remainingArgsToForward,
  ...(internalBuildInfoFile ? ["--tsBuildInfoFile", internalBuildInfoFile] : []),
  "--noEmit",
];

if (!errorsInChangedOnly) {
  const { status, error } = spawnSync(process.execPath, vueTscArgs, { stdio: "inherit" });

  if (error) {
    console.error(error);
  }

  // A failed spawn must surface as a failing exit code instead of
  // silently passing the type check.
  process.exit(status ?? 1);
}

// 归属解析需要捕获完整输出；先打印 stdout 再打印 stderr，不保留实时交错顺序。
// buffer 放宽到 64MB，避免默认 1MB 上限杀掉子进程并截断待解析诊断。
const result = spawnSync(process.execPath, vueTscArgs, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error) {
  console.error(result.error);
  process.exitCode = 1;
} else {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  // 子进程被信号终止（signal 非 null，或 status 为 null）时输出不可信，绝不按依赖豁免
  const interrupted = result.signal !== null || result.status === null;
  const { exitCode, ignoredDependencyErrors } = interrupted
    ? { exitCode: 1, ignoredDependencyErrors: false }
    : getDiagnosticExitResult(result.status, output, specifiedFiles, tmpTsconfigPath);
  if (ignoredDependencyErrors) {
    console.error(
      `\nNote: vue-tsc reported errors only in transitively compiled files, ` +
        `which are ignored by --errors-in-changed-only (exit 0).`,
    );
  }
  // process.exitCode 让异步管道写入自然排空，避免 process.exit 截断尾部输出。
  process.exitCode = exitCode;
}
