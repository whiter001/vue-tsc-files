import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/cli.ts",
  output: {
    dir: "bin",
    format: "es",
  },
  // rolldown 原生支持 TS 转译，无需额外的 typescript 插件
  external: ["fs", "path", "crypto", "module", "child_process", "typescript"],
});
