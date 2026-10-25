# AGENTS.md

Guidance for AI coding assistants working in this repository.

## Project

`vue-tsc-files` — a tiny CLI that runs `vue-tsc` on specific files or recursively expanded directories without ignoring `tsconfig.json`. Directory expansion skips `node_modules` paths (including directory symlink targets) and fails on unreadable directories rather than silently checking a partial file set. Published as `@whiter001/vue-tsc-files`.

It also ships an agent skill at `.agents/skills/vue-tsc-files/` (inside the npm package via `files`); users install it with `vue-tsc-files install --skill [--user]`, which copies that directory into `.agents/skills/` and never loads TypeScript.

## Commands

```sh
pnpm install
pnpm build      # rolldown → vue-tsc-files (the published bundle)
pnpm check      # oxlint + oxfmt --check + tsc --noEmit
pnpm test       # builds first (pretest), then node:test unit + integration tests
pnpm bench      # builds first (prebench), then the performance matrix in bench/
```

- Runtime: Node >= 20.19; development: Node >= 22.18 (tests, the benchmark and the release script use Node's built-in type stripping).
- Source lives in `src/` (only `cli.ts` + `util.ts`); the root `vue-tsc-files` file is the gitignored build output — never edit it directly.
- `bench/` measures, it does not assert a budget. Scenarios live in `bench/scenarios.ts`; each declares the exit code, key output and diagnostic-line count the run must produce. Every timed run is validated before its timing is kept, so a broken fixture can never masquerade as a fast result, and leftover temp artifacts fail the run too. A scenario may also declare `requiresVue` (the fixture's `node_modules/vue` links to the repo's real install, so template type-checking is actually on) and `negativeCanary` (before any timing, every mode of that scenario must reject a template that references a nonexistent binding with exactly one `TS2339` on the expected file; otherwise the whole scenario is skipped and recorded as a failure). The canary runs outside the timed runs and leaves no cache or fixture behind. All three modes must pass `--pretty false`, otherwise a colored `FORCE_COLOR` environment splits `error` from `TSxxxx` and the diagnostic-line count silently reads 0. Run it standalone — a concurrent build or test suite invalidates the numbers.
- `vue` is a devDependency purely so the `vue-sfc` benchmark fixture resolves the real Vue types; it is not a runtime dependency.
- Release: `node scripts/release.mjs [patch|minor|major|x.y.z] [--commit] [--dry-run] [--yes]`. Unknown flags abort; a real publish asks for confirmation unless `--yes`. `--commit` requires an empty index before publishing, creates an annotated tag, and pushes the branch plus that tag. A Git failure after publishing preserves the published version; only a failed publish rolls back the script's version edit.

## Issue reporting convention (mandatory)

Any problem you (the AI assistant) discover while **using** this package — misbehavior, misleading errors, docs not matching behavior, missing features — MUST be filed as a GitHub issue in `whiter001/vue-tsc-files`, not just mentioned in the chat or silently worked around.

1. **Deduplicate first**: run `gf issue list -R whiter001/vue-tsc-files --state open` (or `gh issue list -R whiter001/vue-tsc-files`). If an open issue already covers it, comment there instead of opening a duplicate.
2. **File the issue** with the `ai-agent` label and a `[AI]` title prefix:

   ```sh
   gf issue create -R whiter001/vue-tsc-files --title "[AI] <one-line summary>" --body-file - <<'EOF'
   ## 现象
   <what happened, actual output>

   ## 复现
   <exact command + minimal setup>

   ## 预期
   <expected behavior>

   ## 环境
   <vue-tsc-files version, vue-tsc/typescript versions, Node, OS>
   EOF
   ```

   If `gf` is unavailable: `gh issue create -R whiter001/vue-tsc-files --label ai-agent`, or plain `curl` against the GitHub REST API.

3. **Record the issue number** in your reply to the user, then continue the original task.
4. **After the problem is fixed**, comment on the issue explaining the fix and close it.

## Code style

- Match the existing conventions: TypeScript ESM, no comments that restate the code, Chinese comments for non-obvious rationale (the codebase mixes English docstrings with Chinese rationale comments).
- Every behavior fix ships with a test: unit tests in `test/util.test.ts`, end-to-end CLI tests in `test/cli.test.ts`, and isolated release workflow tests in `test/release.test.ts` (stub npm/pnpm; local bare remotes only).
- `pnpm check` and `pnpm test` must both pass before committing.
