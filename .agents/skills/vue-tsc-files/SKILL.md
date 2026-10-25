---
name: vue-tsc-files
description: 用 vue-tsc 对指定文件、目录或 Git 收集的 .vue/.ts/.tsx/.mts/.cts 文件做类型检查，沿用项目 tsconfig 的编译选项，并按原配置范围补充 .d.ts/.d.mts/.d.cts 声明；不按 include/exclude 过滤显式指定的源文件。当用户要求"只类型检查这几个文件"、检查暂存/改动文件、配置 lint-staged，或直接跑 `vue-tsc <files>` 不会加载项目 tsconfig 时使用。也匹配 vue-tsc-files / tsc-files 关键词。
whenToUse: 用户要求对指定文件、目录、暂存或改动的 .vue/.ts/.tsx/.mts/.cts 文件运行 vue-tsc 类型检查时
---

# vue-tsc-files

支持直接传入一个或多个文件路径，用项目 tsconfig 的编译选项对指定文件跑 `vue-tsc` 类型检查。
相对路径按当前工作目录（cwd）解析，也支持绝对路径。
也可以传目录：目录会被递归展开成源文件，展开出的文件与显式传入的文件同等待遇。

**不要用裸 `vue-tsc <files>` 来沿用项目配置**：命令行文件模式不会加载项目 tsconfig，
包括其中的 `compilerOptions`。较旧的 TypeScript 会按命令行文件独立编译，可能因缺少项目配置产生误报；
TypeScript 6 在 cwd 存在 tsconfig.json 时会先报 TS5112，要求用 `--ignoreConfig` 明确跳过配置。

本工具在原 tsconfig 旁生成临时配置，保留 `extends` 和其他配置选项，
将 `files` 替换为指定文件及按原配置 `include`/`exclude`/`files` 范围（含 `extends` 链）收集的 `.d.ts/.d.mts/.d.cts`，
并将 `include` 设为 `[]`，避免把项目中的其他源文件全部作为检查入口。检查结束后自动删除临时配置。
显式指定或由目录展开出的源文件不会被原 `include`/`exclude` 过滤；通过 `import` 引入的依赖也可能被检查，即使位于 `exclude` 中。

## 运行

安装依赖时使用完整包名 `@whiter001/vue-tsc-files`，不要安装另一个包 `vue-tsc-files`；安装后提供的命令名是 `vue-tsc-files`。推荐将本工具及所需的 `vue-tsc`、`typescript` 安装为项目 devDependency，再执行：

```bash
pnpm exec vue-tsc-files src/App.vue
npx --no-install vue-tsc-files src/App.vue src/components/Foo.vue
```

使用 `npx` 时建议加 `--no-install`，避免缺少命令时隐式安装推断出的包；短命令名可能被解析成另一个包 `vue-tsc-files`。`--no-install` 不保证只使用当前项目的依赖，也不等同于离线模式，仍可能使用全局安装或已有 npx 缓存中的命令。

普通 shell 通常不会自动把项目的 `node_modules/.bin` 加入 PATH，因此推荐通过包管理器执行；全局安装或自行配置 PATH 后，也可以直接运行命令。lint-staged 会把 `node_modules/.bin` 加入 PATH，配置中可以直接写 `vue-tsc-files`。

不确定当前生效的是哪个包、哪个版本时，先查版本：

```bash
npx --no-install vue-tsc-files --version
```

预期输出格式为 `vue-tsc-files <版本号> (@whiter001/vue-tsc-files)`。

使用 `npm exec` 时，在命令前加 `--`，防止后续的 `--version` / `--help` 等参数被 npm 自身解析；下面的 `--yes=false` 用于拒绝需要确认的安装：

```bash
npm exec --yes=false -- vue-tsc-files --version
npm exec --yes=false -- vue-tsc-files src/App.vue
```

上述调用仍通过命令名查找入口。若版本输出的包名不是 `@whiter001/vue-tsc-files`，应排查同名命令冲突；仅将 `npx` 参数改为 scoped 包名，不足以保证绕过已冲突的本地 bin。需要明确执行本包时，从包含以下依赖路径的项目或工作区目录直接运行：

```bash
node ./node_modules/@whiter001/vue-tsc-files/vue-tsc-files --version
node ./node_modules/@whiter001/vue-tsc-files/vue-tsc-files src/App.vue
```

这会绕开同名 bin 查找；指定入口不存在时直接失败，不会回退执行其他包。

不将工具加入项目依赖的一次性运行方式：

```bash
pnpm dlx @whiter001/vue-tsc-files src/App.vue
```

`dlx` 可能下载包并使用临时或缓存环境，不是“不安装任何包”。使用完整包名可避免包名解析歧义，但不应据此推断实际加载的 `vue-tsc` / `typescript` 版本；需要可重复的依赖版本时，优先将工具及所需的编译器依赖安装在项目中，并通过锁文件固定解析结果。

## 常用参数

| 参数                       | 说明                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `<files...>`               | 要检查的 .vue/.ts/.tsx/.mts/.cts 文件，相对 cwd 解析，也支持绝对路径和多个文件                |
| `<dirs...>`                | 要检查的目录，递归展开其中的 .vue/.ts/.tsx/.mts/.cts 文件；`node_modules` 内的路径跳过        |
| `-p` / `--project <path>`  | 指定 tsconfig（monorepo 里常用 `tsconfig.app.json`）；可传目录，此时读取其中的 tsconfig.json  |
| `--errors-in-changed-only` | 别名 `--changed-only`：完整打印诊断，按指定文件归属过滤类型错误；配置错误及子进程异常始终失败 |
| `--changed`                | 从 Git 收集改动文件（含 staged + unstaged + untracked），可省略命令行文件列表                 |
| `--staged`                 | 按暂存区变更收集文件，实际检查磁盘上的当前内容                                                |
| `--unstaged`               | 只收集工作区与 index 有差异的 tracked 文件（不含 untracked）                                  |
| `--version`                | 打印当前生效的包名与版本后退出，不做类型检查                                                  |

`--errors-in-changed-only` 只按诊断的文件归属过滤，不比较 Git 基线或修改行：
未指定文件中的新错误也可能被豁免，指定文件中的旧错误仍会阻断。
“指定文件”包括显式传入、目录展开和 Git 收集的文件；自动补充的 `.d.ts/.d.mts/.d.cts` 不参与指定文件的错误归属，除非它也被显式传入、由目录展开或由 Git 收集。

lint-staged 配置示例（lint-staged 会自动追加匹配的文件路径，不能把配置中的命令当成无文件参数的独立检查命令）：

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx,mts,cts}": "vue-tsc-files --errors-in-changed-only"
  }
}
```

不用 lint-staged，直接检查改动文件：

```bash
pnpm exec vue-tsc-files --changed --errors-in-changed-only
```

## 目录参数

目录会被递归展开，展开出的文件写进临时配置的 `files`；目录本身不再作为命令行文件传给 `vue-tsc`，
否则会与 `-p` 临时配置冲突（`TS5042`）：

```bash
npx --no-install vue-tsc-files src              # 检查 src 下的全部源文件
npx --no-install vue-tsc-files src src/App.vue  # 目录与文件可以混用
npx --no-install vue-tsc-files --changed src     # 与 Git 收集结果取并集
```

- 展开出的文件不受原 `include`/`exclude` 过滤，与显式传入的文件一致。
- 目录读不了（权限不足、路径消失等）会报出失败路径并以退出码 1 终止，不会把不完整的扫描当成检查通过。
- 名称以 `.ts` 等源文件扩展名结尾的**已有目录**同样会被展开；带受支持扩展名但不存在的路径仍交给 `vue-tsc` 报文件不存在。
- glob（`*`/`?`）不会展开：不存在的路径带通配符会报用法错误，请交给 shell 展开或直接传目录。
- `.` 表示当前工作目录，递归展开其中的受支持文件，不会自动定位到 Git 仓库根目录。目录展开会跳过 `node_modules`，但不会按原 tsconfig 的 `include`/`exclude` 排除构建产物等源文件；目录符号链接也可能指向当前目录之外。需要控制范围时，请传入具体子目录。
- 目录展开后没有可检查文件时：若还有其他有效目标，则警告并继续；若没有任何有效目标且未启用 Git 收集模式，则以退出码 1 报错。Git 收集模式下最终没有可检查文件时，提示后退出 0，不代表执行过类型检查。

## 安装与更新本 skill

本 skill 随 npm 包分发，用以下命令安装到当前工作目录的 `.agents/skills/`（不会自动定位项目或仓库根目录）：

```bash
pnpm exec vue-tsc-files install --skill
```

加 `--user` 装进 `~/.agents/skills/` 对所有项目生效；本地改过的版本重装时需要 `--force` 才会被覆盖。若存在同名命令冲突，按上文直接执行本包入口并追加 `install --skill`。用户想更新本 skill 时优先给安装命令，而不是让用户手工 `cp` 或 `curl`。

## 注意

- `--noEmit` 总是传给底层 vue-tsc，无需手动加。不支持响应文件参数（`@file`），请直接传参；转发时会改变编译选项含义的歧义参数组合会被拒绝，需显式提供选项值。
- 显式文件参数和 `--changed`/`--staged`/`--unstaged` 可以混用，结果取并集。Git 收集模式需要在 Git 仓库内运行；在仓库子目录执行时，只收集该子目录下的变更，跳过已不存在的文件和 node_modules 内容。
- 目录参数的完整行为见上文「目录参数」一节。两处容易踩：`node_modules` 的跳过只作用于目录展开，显式传入的文件和 `import` 引入的依赖照常检查；目录读不了会以退出码 1 报出失败路径，不会当成检查成功。
- 首个实参裸写 `install` 会被当成子命令；要检查名为 `install` 的目录请写 `./install`。
- `--staged` 按暂存区选文件、但检查的是磁盘上的当前内容，不是 index 中的快照。
- `skipLibCheck` 默认按 `true` 处理以提速；用户 tsconfig 或 `extends` 链中显式写了就以用户的为准。
- 启用 incremental 或 composite 时使用独立临时 build-info 文件，用后清理。配置及 CLI 的 `tsBuildInfoFile` 会被内部临时路径覆盖，不改写项目持久缓存，也不提供跨运行缓存复用；强制终止或机器崩溃可能阻止清理。
- monorepo 下用 `-p` 指定对应的子 tsconfig。`references` 会保留，但工具不自动构建引用项目，也不移除 `composite` / `declaration` 选项。引用项目输出可能需要预先构建，否则仍会报 TS6305；不能把 solution tsconfig 的调用当成完整的多项目检查。
- 非零退出码表示检查失败或运行／用法错误，包括需要阻断的类型诊断、配置错误、依赖缺失和子进程异常；`--errors-in-changed-only` 不会豁免定位在配置文件上的错误、无文件位置的全局诊断、子进程中断或无可识别诊断的异常失败。
- 未传有效文件或目录、且未启用 Git 收集模式时，以退出码 1 报用法错误；Git 收集模式没有可检查文件时提示并退出 0，这不表示已执行类型检查。
