# vue-tsc-files

[English](./README.md) | [简体中文](./README.zh-CN.md)

A tiny tool to run `vue-tsc` on specific files without ignoring `tsconfig.json`.

Ported from [tsc-files](https://github.com/gustavopch/tsc-files).

## Installation

```sh
npm i -D @whiter001/vue-tsc-files
```

```sh
pnpm add -D @whiter001/vue-tsc-files
```

`vue-tsc` and `typescript` are peer dependencies, install the versions matching your project:

```sh
pnpm add -D vue-tsc typescript
```

## Why

I wanted to type-check **only the staged files** with [lint-staged](https://github.com/okonet/lint-staged).

## Usage

With lint-staged:

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx}": "vue-tsc-files"
  }
}
```

## pnpm support

Works with npm and pnpm. The CLI locates the installed `vue-tsc` package via `require.resolve` and executes its JS entry with the current Node binary, so pnpm's symlinked `node_modules` layout is fully supported.

A failed type check (or a failed spawn) always exits with a non-zero code.

## Only fail on errors in the specified files

`vue-tsc` compiles the specified files together with everything they transitively import, so the output may contain pre-existing type errors in files you did not touch. Pass `--errors-in-changed-only` (alias: `--changed-only`) to ignore those: the full output is still printed, but only errors reported in the files passed on the command line (plus global config errors) affect the exit code.

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx}": "vue-tsc-files --errors-in-changed-only"
  }
}
```

## Type-check changed files without lint-staged

Pass `--changed` to collect the file list from git instead of the command line. It uses `git status` semantics — modified, added, renamed, copied, unmerged and untracked `.ts`/`.tsx`/`.vue` files in the working tree are checked; deleted files are skipped. Both staged (index) and unstaged (worktree) changes are included. It can be combined with `--errors-in-changed-only`:

```sh
vue-tsc-files --changed --errors-in-changed-only
```

Pass `--staged` to check only what the next commit would contain (the git index) — the classic pre-commit semantic, without needing lint-staged. **Note: `--staged` selects files by the index but type-checks their current on-disk content.** If you stage a file and then keep editing it without `git add`, the unstaged edits are checked too (the same limitation lint-staged has without its stash feature):

```sh
vue-tsc-files --staged --errors-in-changed-only
```

Pass `--unstaged` to check only tracked files whose worktree content differs from the index (`git diff` semantic). Untracked files are not part of git's "unstaged" concept — use `--changed` to include them:

```sh
vue-tsc-files --unstaged --errors-in-changed-only
```

Explicitly passed files, `--changed`, `--staged` and `--unstaged` can be mixed (the union is checked). Note that `--changed` already includes staged changes, so combining it with `--staged` is redundant; `--changed --unstaged` is redundant for the same reason. Explicit file paths are resolved against the current working directory (absolute paths also work); git-collected paths are made relative to the working directory. When run from a repository subdirectory, only changes under that directory are collected.

## Sidenotes

Flag "--noEmit" is always passed to underlying `vue-tsc` by default.

`vue-tsc-files` passes module declarations and namespaces from `d.ts` files to `vue-tsc`, so please make sure that needed declarations are inside `d.ts` files. The `d.ts` scan skips `node_modules`, dot directories (`.git`, `.github`, ...) and common build outputs (`dist`, `build`, `out`, `coverage`).

```javascript
// example.d.ts
declare module "@vue/runtime-core" {
  interface ComponentCustomProperties {
    $custom: MyCustomType;
  }
}
```

## Development

Requires Node >= 22.18 (tests rely on built-in TypeScript type stripping).

```sh
pnpm install
pnpm build      # rolldown → bin/cli.js
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # node:test unit + integration tests
```

## License

Released under the [MIT License](./LICENSE).
