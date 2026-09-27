# vue-tsc-files

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个轻量工具：在不忽略 `tsconfig.json` 的前提下，只对指定的文件运行 `vue-tsc`。

移植自 [tsc-files](https://github.com/gustavopch/tsc-files)。

## 安装

```sh
npm i -D @whiter001/vue-tsc-files
```

```sh
pnpm add -D @whiter001/vue-tsc-files
```

`vue-tsc` 与 `typescript` 是 peerDependencies，请按项目需要安装对应版本：

```sh
pnpm add -D vue-tsc typescript
```

## 为什么要用

我想在 [lint-staged](https://github.com/okonet/lint-staged) 里只对**已暂存的文件**做类型检查。

## 用法

配合 lint-staged：

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx}": "vue-tsc-files"
  }
}
```

## pnpm 支持

npm 与 pnpm 都已支持。CLI 通过 `require.resolve` 定位已安装的 `vue-tsc` 包，再用当前 Node 可执行文件调用其 JS 入口，因此完全兼容 pnpm 的符号链接 `node_modules` 布局。

类型检查失败（或子进程启动失败）会以非零退出码退出。

## 只对指定文件自身的错误失败

`vue-tsc` 在编译指定文件的同时会一并编译它们传递依赖进来的所有内容，因此输出里可能夹杂你没碰过的文件中的历史错误。加上 `--errors-in-changed-only`（别名：`--changed-only`）可以忽略这些：完整输出仍然原样打印，但只有命令行传入的文件（加上全局配置错误）的错误才会影响退出码。

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx}": "vue-tsc-files --errors-in-changed-only"
  }
}
```

## 脱离 lint-staged 直接检查变更文件

传入 `--changed` 可以让工具从 git 工作区自动收集文件列表，代替命令行传入。它遵循 `git status` 的语义：已修改、已新增、已重命名、已复制、未合并和未跟踪的 `.ts`/`.tsx`/`.vue` 文件都会被检查；已删除的文件被跳过。同时包含已暂存（index）和未暂存（worktree）两类变更。可以与 `--errors-in-changed-only` 组合：

```sh
vue-tsc-files --changed --errors-in-changed-only
```

传入 `--staged` 则只检查下次提交将要带入的内容（git index），即经典的 pre-commit 语义，不需要 lint-staged：

```sh
vue-tsc-files --staged --errors-in-changed-only
```

注意 `--staged` 是按 index 选出文件，但实际检查的是这些文件**当前在磁盘上的内容**。如果对一个文件执行 `git add` 之后继续修改但没有再 `git add`，那些未暂存的修改也会被一并检查（这是 lint-staged 在没有 stash 时的同款限制）。

传入 `--unstaged` 只检查 worktree 与 index 不一致的那些已跟踪文件（`git diff` 语义）。未跟踪文件不属于 git 的"未暂存"概念——需要包含它们请用 `--changed`：

```sh
vue-tsc-files --unstaged --errors-in-changed-only
```

命令行显式传入的文件、`--changed`、`--staged`、`--unstaged` 可以混用，结果取并集。显式传入的文件路径相对于当前工作目录解析（也支持绝对路径）；git 收集出的路径会被转成相对于工作目录的路径。在仓库的子目录下运行时，只收集该子目录下的变更。

## 备注

默认会向底层 `vue-tsc` 始终传入 `--noEmit`。

`vue-tsc-files` 会把 `d.ts` 文件里的模块声明和命名空间传给 `vue-tsc`，请确保所需声明位于 `d.ts` 文件中。`d.ts` 扫描会跳过 `node_modules`、点开头的目录（`.git`、`.github` 等）以及常见构建产物目录（`dist`、`build`、`out`、`coverage`）。

```javascript
// example.d.ts
declare module "@vue/runtime-core" {
  interface ComponentCustomProperties {
    $custom: MyCustomType;
  }
}
```

## 开发

需要 Node >= 22.18（测试依赖内置的 TypeScript 类型剥离）。

```sh
pnpm install
pnpm build      # rolldown → bin/cli.js
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # node:test unit + integration tests
```

## License

Released under the [MIT License](./LICENSE).
