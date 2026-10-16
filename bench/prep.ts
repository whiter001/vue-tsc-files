/**
 * 只测量 wrapper 的"准备"成本：解析参数、生成临时 tsconfig、定位 vue-tsc 入口。
 * 不 spawn 编译器，因此与 wrapper 的总耗时之差可以粗略看作编译阶段——
 * 但只是粗略：这里同样含 Node 启动与模块加载，两者不完全可比。
 *
 * 与 test/cli.test.ts 里加载 src/util.ts 的做法一致，靠 Node 的类型剥离直接跑 TS。
 */
import { dirname, join } from "node:path";
import { createAndSetupTsConfig, createResolverRequires, setupArgs } from "../src/util.ts";

const { files, projectValue, remainingArgsToForward } = setupArgs();
const tmpTsconfigPath = createAndSetupTsConfig(files, projectValue, remainingArgsToForward);

let entry = "";
for (const req of createResolverRequires()) {
  try {
    entry = join(dirname(req.resolve("vue-tsc/package.json")), "bin", "vue-tsc.js");
    break;
  } catch {
    // 尝试下一个锚点
  }
}

console.log(JSON.stringify({ tmpTsconfigPath, entry }));
