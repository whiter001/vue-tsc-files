---
name: vue-tsc-files
description: 用 vue-tsc 对指定的 .vue/.ts/.tsx/.mts/.cts 文件做类型检查，且不忽略 tsconfig.json 的 include/exclude。当用户要求"只类型检查这几个文件"、检查暂存/改动文件、配置 lint-staged，或直接跑 `vue-tsc <files>` 会绕过 tsconfig 导致误报时使用。也匹配 vue-tsc-files / tsc-files 关键词。
whenToUse: 用户要求对指定文件、暂存或改动的 .vue/.ts/.tsx/.mts/.cts 文件运行 vue-tsc 类型检查时
---

# vue-tsc-files

对指定文件跑 `vue-tsc` 类型检查，同时保留 tsconfig.json 的 `include`/`exclude`/`extends` 语义。

**不要直接跑 `vue-tsc <files>`**：裸 vue-tsc 会忽略 tsconfig 的 include/exclude，
按命令行文件独立编译，典型症状是冒出一堆项目里本来被排除的误报。
正确做法是用本工具，它会在原 tsconfig 旁生成临时 tsconfig（只把指定文件加入 `files`，
其余配置原样继承），检查完自动删除。

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

| 参数                       | 说明                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<files...>`               | 要检查的 .vue/.ts/.tsx/.mts/.cts 文件，相对 cwd 解析，绝对路径也可以                                                 |
| `-p` / `--project <path>`  | 指定 tsconfig（monorepo 里常用 `tsconfig.app.json`）；可传目录，等价 `tsc -p .`                                      |
| `--errors-in-changed-only` | 别名 `--changed-only`：完整打印输出，但只有指定文件自身（和全局配置）的 error 影响退出码，传递依赖里的历史报错不阻断 |
| `--changed`                | 从 git 收集改动文件（含 staged + unstaged + untracked），可省略命令行文件列表                                        |
| `--staged`                 | 只检查暂存区将进入下次提交的文件（pre-commit 语义）                                                                  |
| `--unstaged`               | 只检查工作区与 index 有差异的 tracked 文件（不含 untracked）                                                         |

典型组合：

```bash
# lint-staged 配置里
vue-tsc-files --errors-in-changed-only

# 不用 lint-staged，直接检查所有改动文件
vue-tsc-files --changed --errors-in-changed-only
```

## 注意

- `--noEmit` 总是传给底层 vue-tsc，无需手动加。
- `--staged` 按暂存区选文件、但检查的是磁盘上的当前内容（与不带 stash 的 lint-staged 同样限制）。
- `skipLibCheck` 默认按 `true` 处理以提速；用户 tsconfig 里显式写了就以用户的为准。
- monorepo 下检查报错指向错误的 tsconfig 时，先用 `-p` 指定对应的子 tsconfig。
- 退出码非 0 = 存在需要修复的类型错误（`--errors-in-changed-only` 下历史报错会豁免）。
