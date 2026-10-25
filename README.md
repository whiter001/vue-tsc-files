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

## Running the CLI

The binary lives in the project's `node_modules/.bin`, which is not on your shell's `PATH`. Typing `vue-tsc-files` on its own therefore fails with `command not found` — run it through a package runner instead:

```sh
npx --no-install vue-tsc-files src/App.vue   # npm
pnpm exec vue-tsc-files src/App.vue           # pnpm
npm run type-check -- src/App.vue             # via an npm script
```

**Always keep `--no-install` on `npx`.** Without it, `npx` falls back to installing a _same-named package from the registry_ when the local binary is missing: `vue-tsc-files` on npm is a different project ([leglegend/vue-tsc-files](https://github.com/leglegend/vue-tsc-files), 0.0.6) that supports none of this tool's flags, and its `unknown option` error never says that the wrong package ran. `--no-install` restricts `npx` to the version installed in the project and fails outright when it is missing.

If the package is not installed at all, use the full package name so the short name cannot resolve to the other project:

```sh
pnpm dlx @whiter001/vue-tsc-files src/App.vue
```

`lint-staged` is the exception: it adds `node_modules/.bin` to `PATH`, so the plain `vue-tsc-files` command works in its configuration.

To confirm which package and version is actually in effect:

```sh
npx --no-install vue-tsc-files --version
# vue-tsc-files 1.3.5 (@whiter001/vue-tsc-files)
```

Do not use `npm exec` for this: npm 12 treats `--version` and `--help` as its own flags even after `--` (`npm exec -- node --version` prints npm's version, not Node's), so the tool's own version and help are only reachable through `npx --no-install` or `pnpm exec`.

If `--version` reports anything other than `@whiter001/vue-tsc-files` — which happens when the same-named `vue-tsc-files` is installed alongside it — use the scoped package name, which cannot resolve to the other project:

```sh
npx --no-install @whiter001/vue-tsc-files src/App.vue
```

## Why

I wanted to type-check **only the staged files** with [lint-staged](https://github.com/okonet/lint-staged).

## Why not plain `vue-tsc`

`vue-tsc` checks a project. Its supported invocations are the default whole-project check and `-p <tsconfig>` for pointing at a different one — and in both cases what gets checked is the whole program.

**The whole program is expensive.** Every run builds all of it. That gets slower as the project grows, and the memory it needs grows with it, until on a large enough codebase the check cannot run at all. The output grows too: every pre-existing error is reprinted on every run. On a project that has been accumulating type errors for years, that is neither fast nor actionable, and it blocks your commit for reasons that have nothing to do with you:

```sh
$ vue-tsc --noEmit
src/legacy2.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/legacy3.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/legacy4.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/legacy5.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

**Naming files on the command line is not a usage of `vue-tsc` either.** TypeScript 6 refuses it outright:

```sh
$ vue-tsc src/a.ts
error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.
```

And `-p` cannot be combined with a file list, so there is no supported spelling for "these files":

```sh
$ vue-tsc -p tsconfig.json src/a.ts
error TS5042: Option 'project' cannot be mixed with source files on a command line.
```

Earlier TypeScript versions did not refuse. They ignored `tsconfig.json` silently and checked the files with default options, which is where projects pick up a wall of errors that have nothing to do with their code — on TypeScript 5.x, for instance:

```sh
$ vue-tsc src/a.ts
src/a.ts(1,24): error TS2307: Cannot find module '@/helper' or its corresponding type declarations.

src/View.tsx(1,27): error TS17004: Cannot use JSX unless the '--jsx' flag is provided.
```

`paths`, `baseUrl`, `jsx`, `lib`, `types`, `experimentalDecorators` and the rest are simply not applied, and a lost `strict` fails in the opposite direction by reporting nothing at all.

So "type-check only the files I changed, under the project configuration" is not something `vue-tsc` offers. That gap is what this tool fills, and it is not a replacement either: it writes a temporary `tsconfig.json` next to yours, with `files` set to the files you asked for plus the declaration files your own configuration already covers and `include` set to `[]`, then hands the work to the real `vue-tsc`. The check costs what your change costs instead of what the project costs, and it runs under your real options:

- `--changed`, `--staged` and `--unstaged` select the files from git
- `--errors-in-changed-only` keeps errors in transitively imported files from failing your commit

The project above, with `src/mine.ts` the only file you touched:

```sh
$ npx --no-install vue-tsc-files src/mine.ts --errors-in-changed-only
$ echo $?
0
```

## Usage

With lint-staged:

```json
{
  "lint-staged": {
    "**/*.{vue,ts,tsx,mts,cts}": "vue-tsc-files"
  }
}
```

## Checking a directory

Pass a directory instead of a file list and every `.vue`/`.ts`/`.tsx`/`.mts`/`.cts` file under it is checked:

```sh
npx --no-install vue-tsc-files src
```

The directory is expanded recursively, and the expanded files are treated exactly like explicitly passed ones: they are not filtered by your `include`/`exclude`, and with `--errors-in-changed-only` their errors count while errors in transitively imported files stay exempt. Directory expansion skips paths inside `node_modules`, including directly passed directories and directory symlinks pointing there. This does not prevent checking an explicitly passed file or a transitively imported dependency.

Directories, files and the Git collection flags can be mixed. Existing directories are expanded even when their names end in a source-file extension such as `.ts`. An unreadable directory aborts the check with exit code 1 and reports the failing path; a partial scan is never treated as success. Empty or skipped directories are reported as warnings when other files remain, or as a usage error when no files remain and no Git collection flag was passed.

Missing paths without a supported source-file extension, unsupported file types and glob patterns are usage errors. Missing paths with a supported source-file extension are still passed to `vue-tsc` for its file-not-found diagnostic. Glob patterns are not expanded, so let your shell expand them or pass the directory.

## pnpm support

Works with npm and pnpm. The CLI locates the installed `vue-tsc` package via `require.resolve` and executes its JS entry with the current Node binary, so pnpm's symlinked `node_modules` layout is fully supported.

A failed type check (or a failed spawn) always exits with a non-zero code. When no checkable files are found and none of `--changed`/`--staged`/`--unstaged` was passed, that is a usage error and the CLI exits with code 1.

## Only fail on errors in the specified files

`vue-tsc` compiles the specified files together with everything they transitively import. Pass `--errors-in-changed-only` (alias: `--changed-only`) to ignore errors in non-target source files: the full output is still printed, but only errors in explicitly passed, directory-expanded or Git-collected files affect the diagnostic exit code. Configuration errors and abnormal child-process termination always fail.

Filtering is file-based, not a comparison against a Git baseline or changed lines. Existing errors in target files still fail; newly introduced errors in non-target dependencies may be ignored. Automatically collected declaration files are not targets unless explicitly passed, found by directory expansion or collected by Git.

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
npx --no-install vue-tsc-files -p tsconfig.app.json src/App.vue
npx --no-install vue-tsc-files --project=configs/tsconfig.app.json src/App.vue
npx --no-install vue-tsc-files -p . src/App.vue
```

The temporary tsconfig is created next to the one you specify, so relative `extends`, `baseUrl` and `paths` resolve exactly as they do for your own config.

## Type-check changed files without lint-staged

Pass `--changed` to collect the file list from git instead of the command line. It uses `git status` semantics — modified, added, renamed, copied, unmerged and untracked `.vue`/`.ts`/`.tsx`/`.mts`/`.cts` files in the working tree are checked; deleted files are skipped. Both staged (index) and unstaged (worktree) changes are included. It can be combined with `--errors-in-changed-only`:

```sh
npx --no-install vue-tsc-files --changed --errors-in-changed-only
```

Pass `--staged` to check only what the next commit would contain (the git index) — the classic pre-commit semantic, without needing lint-staged. **Note: `--staged` selects files by the index but type-checks their current on-disk content.** If you stage a file and then keep editing it without `git add`, the unstaged edits are checked too (the same limitation lint-staged has without its stash feature):

```sh
npx --no-install vue-tsc-files --staged --errors-in-changed-only
```

Pass `--unstaged` to check only tracked files whose worktree content differs from the index (`git diff` semantic). Untracked files are not part of git's "unstaged" concept — use `--changed` to include them:

```sh
npx --no-install vue-tsc-files --unstaged --errors-in-changed-only
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

Runtime requirement is Node >= 20.19 (the `engines` field, applies to the published CLI). Development requires Node >= 22.18 because the tests, the benchmark and the release script run TypeScript sources via Node's built-in type stripping — the stricter version does not apply to end users.

```sh
pnpm install
pnpm build      # rolldown → vue-tsc-files
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # builds first (pretest), then node:test unit + integration tests
pnpm bench      # builds first (prebench), then the performance matrix in bench/
```

### Benchmark

`bench/` measures where the time goes instead of asserting a budget — no threshold is enforced, because setting one before having numbers would be guesswork. It compares the wrapper against a direct `vue-tsc` run over the same files and the same compiler options, across simple TS, real Vue SFCs, a wide `include` range, an empty git selection and a large diagnostic output, each under cold, warm and incremental caches.

Every timed run is validated before its timing is kept: the scenario declares the exit code, the key output and the exact diagnostic-line count the run must produce, and leftover temp files fail the run too. A fixture that broke would otherwise register as a suspiciously fast result.

```sh
pnpm bench                              # full matrix
node bench/run.ts --quick               # 3 runs, warm cache only
node bench/run.ts --scenario vue-sfc    # one scenario
node bench/run.ts --json bench.json     # machine-readable results
```

Run it on its own — a concurrent build or test suite invalidates the numbers. Read the caveats printed with the table before comparing cells: process RSS excludes the `vue-tsc` child the wrapper spawns, and `--extendedDiagnostics` covers only the compiler's internal phases.

## License

Released under the [MIT License](./LICENSE).
