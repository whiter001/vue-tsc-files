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
    "**/*.{vue,ts,tsx,mts,cts}": "vue-tsc-files"
  }
}
```

## pnpm support

Works with npm and pnpm. The CLI locates the installed `vue-tsc` package via `require.resolve` and executes its JS entry with the current Node binary, so pnpm's symlinked `node_modules` layout is fully supported.

A failed type check (or a failed spawn) always exits with a non-zero code. When no checkable files are found and none of `--changed`/`--staged`/`--unstaged` was passed, that is a usage error and the CLI exits with code 1.

## Only fail on errors in the specified files

`vue-tsc` compiles the specified files together with everything they transitively import. Pass `--errors-in-changed-only` (alias: `--changed-only`) to ignore errors in non-target source files: the full output is still printed, but only errors in explicitly passed or Git-collected files affect the diagnostic exit code. Configuration errors and abnormal child-process termination always fail.

Filtering is file-based, not a comparison against a Git baseline or changed lines. Existing errors in target files still fail; newly introduced errors in non-target dependencies may be ignored. Automatically collected declaration files are not targets unless explicitly passed or collected by Git.

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx,mts,cts}": "vue-tsc-files --errors-in-changed-only"
  }
}
```

## Using a specific tsconfig

Pass `-p` / `--project` to use a tsconfig other than the root `tsconfig.json` — useful in monorepos with e.g. `tsconfig.app.json` / `tsconfig.node.json`. The path may also be a directory, which resolves to the `tsconfig.json` inside it (like `tsc -p .`):

```sh
vue-tsc-files -p tsconfig.app.json src/App.vue
vue-tsc-files --project=configs/tsconfig.app.json src/App.vue
vue-tsc-files -p . src/App.vue
```

The temporary tsconfig is created next to the one you specify, so relative `extends`, `baseUrl` and `paths` resolve exactly as they do for your own config.

## Type-check changed files without lint-staged

Pass `--changed` to collect the file list from git instead of the command line. It uses `git status` semantics — modified, added, renamed, copied, unmerged and untracked `.vue`/`.ts`/`.tsx`/`.mts`/`.cts` files in the working tree are checked; deleted files are skipped. Both staged (index) and unstaged (worktree) changes are included. It can be combined with `--errors-in-changed-only`:

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

## Agent skill

This repository ships a ready-made [Kimi Code](https://www.kimi.com/code/docs/en/) agent skill at [`.agents/skills/vue-tsc-files/SKILL.md`](./.agents/skills/vue-tsc-files/SKILL.md). It teaches AI coding agents (Kimi Code and anything else that reads the `.agents/skills/` convention) when and how to use `vue-tsc-files` instead of the error-prone bare `vue-tsc <files>` invocation.

The skill is distributed inside the npm package, so one command installs it into the current project:

```sh
npx @whiter001/vue-tsc-files install --skill
```

Add `--user` to install it once for yourself into `~/.agents/skills/`, where it applies to every project:

```sh
npx @whiter001/vue-tsc-files install --skill --user
```

Re-running is safe: an installation that already matches the bundled skill is left alone, and one that differs is reported as a conflict instead of being overwritten — pass `--force` to replace it. The command never loads TypeScript or runs a type check.

If you would rather wire it up by hand, the same file sits in `node_modules/@whiter001/vue-tsc-files/.agents/skills/vue-tsc-files/`:

```sh
mkdir -p .agents/skills
cp -r node_modules/@whiter001/vue-tsc-files/.agents/skills/vue-tsc-files .agents/skills/
```

Or fetch it straight from GitHub, without installing the package:

```sh
mkdir -p .agents/skills/vue-tsc-files
curl -fsSL -o .agents/skills/vue-tsc-files/SKILL.md \
  https://raw.githubusercontent.com/whiter001/vue-tsc-files/master/.agents/skills/vue-tsc-files/SKILL.md
```

## Sidenotes

Flag "--noEmit" is always passed to underlying `vue-tsc` by default. Response-file arguments (`@file`) are not supported; pass arguments directly. Ambiguous argument combinations that would change compiler-option meaning during forwarding are rejected; provide explicit option values.

`vue-tsc-files` collects `.d.ts`, `.d.mts` and `.d.cts` declarations using your tsconfig's own `include`/`exclude`/`files` scope (`extends` chains included), so declarations the project itself would not compile are not pulled in.

`skipLibCheck` defaults to `true` for faster checks; an explicit `skipLibCheck` in your tsconfig (either `true` or `false`) always wins.

The temporary tsconfig is created next to the original one (and removed afterwards), so relative `extends`, `baseUrl`, `paths` and other path-based options resolve exactly as they do for your own config.

When incremental or composite checking is enabled, the wrapper uses a per-run temporary build-info file and removes it afterwards. It overrides configured and CLI `tsBuildInfoFile` paths to avoid modifying your project's persistent cache; there is no cross-run incremental cache reuse. Force-killing the process or a machine crash may prevent cleanup.

Project `references` are preserved, but referenced projects are not automatically built or checked as a complete solution. Their declaration outputs may need to be built first, otherwise errors such as TS6305 can still occur. The wrapper does not remove `composite` or `declaration` options (a note is printed when references are detected).

```javascript
// example.d.ts
declare module "@vue/runtime-core" {
  interface ComponentCustomProperties {
    $custom: MyCustomType;
  }
}
```

## Development

Runtime requirement is Node >= 20.19 (the `engines` field, applies to the published CLI). Development requires Node >= 22.18 because the tests and the release script run TypeScript sources via Node's built-in type stripping — the stricter version does not apply to end users.

```sh
pnpm install
pnpm build      # rolldown → vue-tsc-files
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # builds first (pretest), then node:test unit + integration tests
```

## License

Released under the [MIT License](./LICENSE).
