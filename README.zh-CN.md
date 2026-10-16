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

## 为什么不直接用 `vue-tsc`

`vue-tsc` 检查的是**一个项目**。它受支持的调用方式只有两种：默认的全项目检查，以及用 `-p <tsconfig>` 指向另一个工程——而这两种方式检查的都是整个 program。

**整个 program 很贵。** 每跑一次都要构建全部内容。项目越大越慢，占用的内存随之膨胀，大到一定程度干脆跑不起来。输出同样膨胀：所有历史遗留错误每次都重印一遍。在一个攒了多年类型错误的项目上，这既不快也没法指导行动，还会因为你根本没碰过的文件卡住你的提交：

```sh
$ vue-tsc --noEmit
src/legacy2.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/legacy3.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/legacy4.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/legacy5.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

**在命令行里点名文件，同样不是 `vue-tsc` 的用法。** TypeScript 6 会直接拒绝：

```sh
$ vue-tsc src/a.ts
error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.
```

而 `-p` 又不能和文件列表混用，所以「只查这几个文件」没有任何一种受支持的写法：

```sh
$ vue-tsc -p tsconfig.json src/a.ts
error TS5042: Option 'project' cannot be mixed with source files on a command line.
```

更早的 TypeScript 版本不拒绝，它们**静默忽略** `tsconfig.json`，用默认选项检查那几行文件——比如在 TypeScript 5.x 上，很多项目那堵与自身代码无关的报错墙就是这么来的：

```sh
$ vue-tsc src/a.ts
src/a.ts(1,24): error TS2307: Cannot find module '@/helper' or its corresponding type declarations.

src/View.tsx(1,27): error TS17004: Cannot use JSX unless the '--jsx' flag is provided.
```

`paths`、`baseUrl`、`jsx`、`lib`、`types`、`experimentalDecorators` 之类统统不生效，而丢掉 `strict` 是反方向的漏报——根本不报。

所以「只检查我改动的文件、并且沿用项目配置」这件事，`vue-tsc` 本来就不提供。这个缺口正是本工具补上的，而且它也不是要替代 `vue-tsc`：它在你原有 tsconfig 旁边生成一份临时配置，把 `files` 设成你指定的文件加上你原配置本就覆盖的声明文件、`include` 设为 `[]`，再把活儿交给真正的 `vue-tsc`。于是检查的代价由你的改动决定，而不是由整个项目决定，而且用的就是你真实的编译选项：

- `--changed`、`--staged`、`--unstaged`，从 git 里挑文件
- `--errors-in-changed-only`，传递依赖里的报错不会卡住你的提交

上面那个项目，假设你只动了 `src/mine.ts`：

```sh
$ vue-tsc-files src/mine.ts --errors-in-changed-only
$ echo $?
0
```

## 用法

配合 lint-staged：

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx,mts,cts}": "vue-tsc-files"
  }
}
```

## pnpm 支持

npm 与 pnpm 都已支持。CLI 通过 `require.resolve` 定位已安装的 `vue-tsc` 包，再用当前 Node 可执行文件调用其 JS 入口，因此完全兼容 pnpm 的符号链接 `node_modules` 布局。

类型检查失败（或子进程启动失败）会以非零退出码退出。若最终没有任何可检查文件且未带 `--changed`/`--staged`/`--unstaged`，属于用法错误，以退出码 1 退出。

## 只对指定文件自身的错误失败

`vue-tsc` 在编译指定文件的同时会一并编译它们传递依赖进来的内容。加上 `--errors-in-changed-only`（别名：`--changed-only`）可以忽略非目标源文件中的错误：完整输出仍然打印，但只有显式传入或 Git 收集的文件中的错误才影响诊断退出码。配置错误和子进程异常中断始终视为失败。

过滤按文件归属进行，不比较 Git 基线或修改行。目标文件中的旧错误仍会阻断，非目标依赖中的新错误也可能被忽略。自动补充的声明文件不属于目标，除非它也被显式传入或由 Git 收集。

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx,mts,cts}": "vue-tsc-files --errors-in-changed-only"
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

传入 `--changed` 可以让工具从 git 工作区自动收集文件列表，代替命令行传入。它遵循 `git status` 的语义：已修改、已新增、已重命名、已复制、未合并和未跟踪的 `.vue`/`.ts`/`.tsx`/`.mts`/`.cts` 文件都会被检查；已删除的文件被跳过。同时包含已暂存（index）和未暂存（worktree）两类变更。可以与 `--errors-in-changed-only` 组合：

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

## Agent skill

本仓库自带一份 [Kimi Code](https://www.kimi.com/code/docs/en/) 兼容的 agent skill：[`.agents/skills/vue-tsc-files/SKILL.md`](./.agents/skills/vue-tsc-files/SKILL.md)。它教 AI 编码助手（Kimi Code 以及一切识别 `.agents/skills/` 约定的工具）在合适的时机用 `vue-tsc-files` 代替容易误报的裸 `vue-tsc <files>` 调用。

skill 随 npm 包一起分发，一条命令即可装进当前项目：

```sh
npx @whiter001/vue-tsc-files install --skill
```

加上 `--user` 则装到 `~/.agents/skills/`，对所有项目生效，装一次就够：

```sh
npx @whiter001/vue-tsc-files install --skill --user
```

重复执行是安全的：内容与包内一致时原样跳过；不一致时报冲突而不是默默覆盖，确认要覆盖再加 `--force`。整个命令不加载 TypeScript，也不触发任何类型检查。

想手动接线也行，同一个文件就在 `node_modules/@whiter001/vue-tsc-files/.agents/skills/vue-tsc-files/` 下：

```sh
mkdir -p .agents/skills
cp -r node_modules/@whiter001/vue-tsc-files/.agents/skills/vue-tsc-files .agents/skills/
```

不想装包也可以直接从 GitHub 拉取：

```sh
mkdir -p .agents/skills/vue-tsc-files
curl -fsSL -o .agents/skills/vue-tsc-files/SKILL.md \
  https://raw.githubusercontent.com/whiter001/vue-tsc-files/master/.agents/skills/vue-tsc-files/SKILL.md
```

## 备注

默认会向底层 `vue-tsc` 始终传入 `--noEmit`。不支持响应文件参数（`@file`），请直接传入参数。若歧义参数组合会在转发时改变编译选项的含义，工具会拒绝执行；请显式提供选项值。

`vue-tsc-files` 会补充 `.d.ts`、`.d.mts` 和 `.d.cts` 声明文件。收集遵循你的 tsconfig 自身的 `include`/`exclude`/`files` 范围（含 `extends` 链），项目本身不会编译的声明文件不会被拉进来。

`skipLibCheck` 默认开启以加速检查；如果你的 tsconfig 显式设置了 `skipLibCheck`（无论 `true` 还是 `false`），以你的配置为准。

临时 tsconfig 会创建在原 tsconfig 所在目录（用后删除），因此相对的 `extends`、`baseUrl`、`paths` 等基于路径的选项解析结果与你的原始配置完全一致。

启用 incremental 或 composite 检查时，工具使用每次运行独立的临时 build-info 文件，用后删除。原配置及命令行中的 `tsBuildInfoFile` 路径会被覆盖，避免修改项目的持久缓存；不提供跨运行的增量缓存复用。强制终止进程或机器崩溃可能导致无法清理。

项目 `references` 会被保留，但工具不会自动构建被引用项目，也不能代替完整的多项目检查。引用项目的声明输出可能需要预先构建，否则仍会出现 TS6305 等错误。工具不会移除 `composite` 或 `declaration` 选项（检测到 references 时会打印提示）。

```javascript
// example.d.ts
declare module "@vue/runtime-core" {
  interface ComponentCustomProperties {
    $custom: MyCustomType;
  }
}
```

## 开发

运行时要求是 Node >= 20.19（`engines` 字段，面向使用已发布 CLI 的用户）。开发需要 Node >= 22.18，因为测试和发布脚本直接通过 Node 内置的类型剥离运行 TypeScript 源码——这个更高的版本要求不面向最终用户。

```sh
pnpm install
pnpm build      # rolldown → vue-tsc-files
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # 先构建（pretest），再跑 node:test 单元 + 集成测试
```

## License

Released under the [MIT License](./LICENSE).
