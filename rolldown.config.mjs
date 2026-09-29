import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/cli.ts",
  platform: "node",
  output: {
    file: "vue-tsc-files",
    format: "es",
    // 产物只有几 KB，minify 收益可忽略，反而让崩溃栈落在单行不可定位
    minify: false,
  },
  // platform: "node" 自动 external 所有 Node 内置模块（含 node: 前缀写法）；
  // typescript 是 peerDependency，由消费者项目提供
  external: ["typescript"],
});
