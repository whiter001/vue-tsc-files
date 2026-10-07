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

类型检查失败（或子进程启动失败）会以非零退出码退出。若最终没有任何可检查文件且未带 `--changed`/`--staged`/`--unstaged`，属于用法错误，以退出码 1 退出。

## 只对指定文件自身的错误失败

`vue-tsc` 在编译指定文件的同时会一并编译它们传递依赖进来的所有内容，因此输出里可能夹杂你没碰过的文件中的历史错误。加上 `--errors-in-changed-only`（别名：`--changed-only`）可以忽略这些：完整输出仍然原样打印，但只有命令行传入的文件（加上全局配置错误）的错误才会影响退出码。

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx}": "vue-tsc-files --errors-in-changed-only"
  }
}
```

## 指定其他 tsconfig

用 `-p` / `--project` 指定根目录 `tsconfig.json` 之外的配置——适合 monorepo 里的 `tsconfig.app.json` / `tsconfig.node.json` 等场景。路径也可以是目录，此时读取其中的 `tsconfig.json`（与 `tsc -p .` 一致）：

```sh
vue-tsc-files -p tsconfig.app.json src/App.vue
vue-tsc-files --project=configs/tsconfig.app.json src/App.vue
vue-tsc-files -p . src/App.vue
```

临时 tsconfig 会创建在你指定的配置旁边，因此相对的 `extends`、`baseUrl`、`paths` 解析结果与原配置完全一致。

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

`vue-tsc-files` 会把 `d.ts` 文件里的模块声明和命名空间传给 `vue-tsc`，请确保所需声明位于 `d.ts` 文件中。`d.ts` 的收集遵循你的 tsconfig 自身的 `include`/`exclude`/`files` 范围（含 `extends` 链），项目本身不会编译的声明文件不会被拉进来。

`skipLibCheck` 默认开启以加速检查；如果你的 tsconfig 显式设置了 `skipLibCheck`（无论 `true` 还是 `false`），以你的配置为准。

临时 tsconfig 会创建在原 tsconfig 所在目录（用后删除），因此相对的 `extends`、`baseUrl`、`paths` 等基于路径的选项解析结果与你的原始配置完全一致。

不会跟随项目 `references`：对 solution 风格的 tsconfig 做检查时，被引用项目的 composite/declaration 约束不会生效（检测到 references 时会打印提示）。

```javascript
// example.d.ts
declare module "@vue/runtime-core" {
  interface ComponentCustomProperties {
    $custom: MyCustomType;
  }
}
```

## 开发

运行时要求是 Node >= 20.19（`engines` 字段，面向使用已发布 CLI 的用户）。开发需要 Node >= 22.18，因为测试直接通过 Node 内置的类型剥离运行 TypeScript 源码——这个更高的版本要求不面向最终用户。

```sh
pnpm install
pnpm build      # rolldown → vue-tsc-files
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # 先构建（pretest），再跑 node:test 单元 + 集成测试
```

## License

Released under the [MIT License](./LICENSE).
