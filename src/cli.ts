#! /usr/bin/env node
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import {
  setupArgs,
  createAndSetupTsConfig,
  createResolverRequires,
  filterErrorsInFiles,
  stripAnsiCodes,
} from "./util.ts";

const { files, specifiedFiles, errorsInChangedOnly, remainingArgsToForward, projectValue } =
  setupArgs();

const tmpTsconfigPath = createAndSetupTsConfig(files, projectValue);

/**
 * Resolves the JS entry of the installed vue-tsc package.
 *
 * 优先从 cwd 解析：dlx/npx 场景下 bundle 在临时沙箱里，从自身位置解析
 * 拿到的是沙箱自动安装的 peer 副本，版本可能与项目不符。定位 package.json
 * 再拼 bin 路径，而不是推导 ../.bin/vue-tsc：pnpm 的符号链接布局下真实
 * 包旁边没有 .bin。
 *
 * @returns The absolute path of vue-tsc's cli entry file.
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
