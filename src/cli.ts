#! /usr/bin/env node
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { createRequire } from "module";
import { setupArgs, createAndSetupTsConfig, filterErrorsInFiles, stripAnsiCodes } from "./util.ts";

// ESM 下没有全局 require，用 createRequire 保持原有的包定位能力
const require = createRequire(import.meta.url);

const { files, specifiedFiles, errorsInChangedOnly, remainingArgsToForward, projectValue } =
  setupArgs();

const tmpTsconfigPath = createAndSetupTsConfig(files, projectValue);

/**
 * Resolves the JS entry of the installed vue-tsc package.
 *
 * The previous implementation derived `../.bin/vue-tsc` from the
 * resolved typescript package path, which breaks under pnpm because
 * packages are symlinks into the virtual store and the `.bin` folder
 * does not exist next to the real location. Resolving the vue-tsc
 * package itself and invoking its JS entry with the current node
 * binary works with npm and pnpm on every platform.
 *
 * @returns The absolute path of vue-tsc's cli entry file.
 */
function resolveVueTscEntry(): string {
  try {
    const packageJsonPath = require.resolve("vue-tsc/package.json");
    return join(dirname(packageJsonPath), "bin", "vue-tsc.js");
  } catch {
    // vue-tsc 未来版本若添加 exports 且未导出 ./package.json，
    // 回退到直接解析 bin 入口子路径
    return require.resolve("vue-tsc/bin/vue-tsc.js");
  }
}

let vueTscEntry: string;
try {
  vueTscEntry = resolveVueTscEntry();
} catch {
  console.error("Cannot find vue-tsc. Please install it first, e.g. `npm i -D vue-tsc`.");
  process.exit(1);
}

const vueTscArgs = [vueTscEntry, "-p", tmpTsconfigPath, ...remainingArgsToForward, "--noEmit"];

if (!errorsInChangedOnly) {
  const { status, error } = spawnSync(process.execPath, vueTscArgs, { stdio: "inherit" });

  if (error) {
    console.error(error);
  }

  // A failed spawn must surface as a failing exit code instead of
  // silently passing the type check.
  process.exit(status ?? 1);
}

// --errors-in-changed-only: 需要解析输出，不能用 stdio: "inherit" 直接透传。
// 完整输出原样打印，但只有指定文件自身的 error（和全局配置错误）影响退出码，
// 传递依赖的历史错误原样展示但不阻断。
// 注意：与 inherit 模式的实时交错输出不同，这里会先打印全部 stdout 再打印
// 全部 stderr；tsc 的诊断都走 stdout，stderr 只有异常信息，实际影响可忽略。
// spawnSync 默认 maxBuffer 为 1MB，大仓库输出超限会杀掉子进程并截断输出，
// 而恰恰是这个模式需要完整输出做归属解析，故放宽到 64MB。
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

  const status = result.status ?? 1;
  if (status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(output, specifiedFiles);

    if (errorsInSpecifiedFiles.length > 0 || globalErrors.length > 0) {
      process.exitCode = status;
    } else if (!/error TS\d+:/.test(stripAnsiCodes(output))) {
      // 非零退出但输出里没有任何可识别的诊断（如 vue-tsc 自身崩溃），
      // 保守起见按失败处理
      process.exitCode = status;
    } else {
      console.error(
        `\nNote: vue-tsc reported errors only in transitively compiled files, ` +
          `which are ignored by --errors-in-changed-only (exit 0).`,
      );
    }
  }
  // 不用 process.exit：对管道的 stdout/stderr 写入是异步的，立即退出
  // 可能截断尾部输出；设置 exitCode 让事件循环自然排空
}
