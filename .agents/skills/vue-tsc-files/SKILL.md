---
name: vue-tsc-files
description: 用 vue-tsc 对指定或 Git 收集的 .vue/.ts/.tsx/.mts/.cts 文件做类型检查，沿用项目 tsconfig 的编译选项，并按原配置范围补充 .d.ts 声明；不按 include/exclude 过滤显式指定的源文件。当用户要求"只类型检查这几个文件"、检查暂存/改动文件、配置 lint-staged，或直接跑 `vue-tsc <files>` 不会加载项目 tsconfig 时使用。也匹配 vue-tsc-files / tsc-files 关键词。
whenToUse: 用户要求对指定文件、暂存或改动的 .vue/.ts/.tsx/.mts/.cts 文件运行 vue-tsc 类型检查时
---

# vue-tsc-files

支持直接传入一个或多个文件路径，用项目 tsconfig 的编译选项对指定文件跑 `vue-tsc` 类型检查。
相对路径按当前工作目录（cwd）解析，也支持绝对路径。

**不要用裸 `vue-tsc <files>` 来沿用项目配置**：命令行文件模式不会加载项目 tsconfig，
包括其中的 `compilerOptions`。较旧的 TypeScript 会按命令行文件独立编译，可能因缺少项目配置产生误报；
TypeScript 6 在 cwd 存在 tsconfig.json 时会先报 TS5112，要求用 `--ignoreConfig` 明确跳过配置。

本工具在原 tsconfig 旁生成临时配置，保留 `extends` 和其他配置选项，
将 `files` 替换为指定文件及按原配置 `include`/`exclude`/`files` 范围（含 `extends` 链）收集的 `.d.ts`，
并将 `include` 设为 `[]`，避免把项目中的其他源文件全部作为检查入口。检查结束后自动删除临时配置。
显式指定的源文件不会被原 `include`/`exclude` 过滤；通过 `import` 引入的依赖也可能被检查，即使位于 `exclude` 中。

## 运行

项目已装 devDependency 时（推荐，走项目自己的 vue-tsc/typescript 版本）：

```bash
npx vue-tsc-files src/App.vue src/components/Foo.vue
pnpm exec vue-tsc-files src/App.vue
```

未安装为 devDependency 时也可免安装直跑（项目里装了 vue-tsc/typescript 时优先用项目版本；未装则由 dlx 自动安装 peer 副本，版本可能与项目预期不同）：

```bash
pnpm dlx @whiter001/vue-tsc-files src/App.vue
```

## 常用参数

| 参数                       | 说明                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<files...>`               | 要检查的 .vue/.ts/.tsx/.mts/.cts 文件，相对 cwd 解析，也支持绝对路径和多个文件                                              |
| `-p` / `--project <path>`  | 指定 tsconfig（monorepo 里常用 `tsconfig.app.json`）；可传目录，此时读取其中的 tsconfig.json                                |
| `--errors-in-changed-only` | 别名 `--changed-only`：完整打印诊断，但只有指定文件自身的错误和无文件位置的全局错误影响诊断退出码；未指定文件中的错误不阻断 |
| `--changed`                | 从 Git 收集改动文件（含 staged + unstaged + untracked），可省略命令行文件列表                                               |
| `--staged`                 | 按暂存区变更收集文件，实际检查磁盘上的当前内容                                                                              |
| `--unstaged`               | 只收集工作区与 index 有差异的 tracked 文件（不含 untracked）                                                                |

`--errors-in-changed-only` 只按诊断的文件归属过滤，不比较 Git 基线或修改行：
未指定文件中的新错误也可能被豁免，指定文件中的旧错误仍会阻断。
“指定文件”包括显式传入的文件和 Git 收集的文件；自动补充的 `.d.ts` 不参与指定文件的错误归属，除非它也被显式传入或由 Git 收集。

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

## 注意

- `--noEmit` 总是传给底层 vue-tsc，无需手动加。
- 显式文件参数和 `--changed`/`--staged`/`--unstaged` 可以混用，结果取并集。Git 收集模式需要在 Git 仓库内运行；在仓库子目录执行时，只收集该子目录下的变更，跳过已不存在的文件和 node_modules 内容。
- `--staged` 按暂存区选文件、但检查的是磁盘上的当前内容，不是 index 中的快照。
- `skipLibCheck` 默认按 `true` 处理以提速；用户 tsconfig 或 `extends` 链中显式写了就以用户的为准。
- monorepo 下用 `-p` 指定对应的子 tsconfig。工具不会跟随 `references` 检查被引用的项目；不能把对 solution tsconfig 的调用当成完整的多项目检查。
- 非零退出码表示检查失败或运行／用法错误，包括需要阻断的类型诊断、配置读取失败、依赖缺失和子进程异常；`--errors-in-changed-only` 不会豁免无文件位置的全局诊断或无可识别诊断的异常失败。
- 未传有效文件且未启用 Git 收集模式时，以退出码 1 报用法错误；Git 收集模式没有可检查文件时提示并退出 0，这不表示已执行类型检查。
