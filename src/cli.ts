#! /usr/bin/env node
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { createRequire } from "module";
import { setupArgs, createAndSetupTsConfig } from "./util.ts";

// ESM 下没有全局 require，用 createRequire 保持原有的包定位能力
const require = createRequire(import.meta.url);

const { files, remainingArgsToForward, projectValue } = setupArgs();

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

const { status, error } = spawnSync(
  process.execPath,
  [vueTscEntry, "-p", tmpTsconfigPath, ...remainingArgsToForward, "--noEmit"],
  { stdio: "inherit" },
);

if (error) {
  console.error(error);
}

// A failed spawn must surface as a failing exit code instead of
// silently passing the type check.
process.exit(status ?? 1);
