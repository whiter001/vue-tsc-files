import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/cli.ts",
  output: {
    file: "vue-tsc-files",
    format: "es",
    minify: true,
  },
  // rolldown 原生支持 TS 转译与 ESM minify，无需额外插件
  // 保留 shebang 让 npm i -g 后生成可执行的 vue-tsc-files 命令
  external: ["fs", "path", "crypto", "module", "child_process", "typescript"],
});
