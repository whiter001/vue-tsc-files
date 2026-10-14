#!/usr/bin/env node
// One-shot npm release: bump version -> build -> publish -> optional git sync.
//
// Usage: see RELEASE_USAGE (also printed by --help).
//
// Notes:
// - Requires Node >= 22.18: the .ts helper below relies on native type
//   stripping; a startup guard turns old-Node load errors into a clear message.
// - Unknown flags or targets abort with usage instead of silently falling back
//   to a default patch release (issue #16: `--help` used to start a publish).
// - A confirmation prompt guards the real publish; --yes skips it.
// - Skips the version bump when the target equals the current version; the
//   rewrite touches only the top-level `version` field, so hand formatting and
//   other uncommitted edits survive both the bump and the rollback.
// - Runs `pnpm publish --no-git-checks`, which triggers `prepublishOnly` ->
//   `pnpm run check && pnpm run test` (pretest -> build). --no-git-checks skips
//   pnpm's own git cleanliness check so the script works even when the working
//   tree has uncommitted local edits (e.g. a release script that hasn't been
//   committed yet).
// - Publish registry is pinned via package.json `publishConfig.registry`,
//   so the script doesn't have to know about the user's default registry
//   (commonly a read-only mirror like registry.npmmirror.com).
// - --commit pre-checks git (empty index, HEAD, branch, origin, free tag,
//   identity) so an obvious mistake can't surface only after the version is
//   already on npm (#21). The tag is annotated because `--follow-tags` skips
//   lightweight ones, and branch + tag go out in one `--atomic` push.
// - A same-version --commit still commits a hand-edited package.json; with
//   nothing to commit the commit is skipped but the tag is still pushed.
// - The version edit is restored verbatim only when the publish itself failed;
//   a git failure afterwards keeps the published version and prints the rest.
// - Does NOT touch git unless --commit is passed.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 静态 import .ts 在旧版 Node 会在模块加载阶段直接抛 ERR_UNKNOWN_FILE_EXTENSION，
// 轮不到脚本自己的报错逻辑，所以先查版本再动态 import。
const [nodeMaj, nodeMin] = process.version.slice(1).split(".").map(Number);
if (!(nodeMaj > 22 || (nodeMaj === 22 && nodeMin >= 18))) {
  console.error(
    `error: release.mjs imports a .ts module and needs Node >= 22.18 (found ${process.version}).`,
  );
  process.exit(1);
}
const { RELEASE_USAGE, bumpVersion, parseReleaseArgs } = await import("./release-args.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");

function npmWhoAmI(registry) {
  // Windows 上 npm 是 npm.cmd，不带 shell 的 spawnSync 会 ENOENT。
  // 必须对发布 registry 检查登录态：用户默认 registry 常是只读镜像
  // （如 registry.npmmirror.com），对它 whoami 永远未登录。
  const args = ["whoami"];
  if (registry) args.push(`--registry=${registry}`);
  const r = spawnSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (r.error || r.status !== 0) {
    throw new Error(
      `Not logged in to npm (${registry ?? "default registry"}). Run \`npm login\` first.`,
    );
  }
  return r.stdout.trim();
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`Command failed (exit ${r.status}): ${cmd}`);
  }
}

// 前置检查用：只读 git，不碰工作区/索引/远端
function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.error) {
    throw new Error(`Cannot run git ${args[0]}: ${r.error.message}. Is git installed?`);
  }
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

function readPkg() {
  const text = readFileSync(PKG_PATH, "utf8");
  return { text, data: JSON.parse(text) };
}

/** 返回 text 中从 start（必须是 `"`）开始的字符串字面量的结束下标（不含） */
function scanStringEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") i += 2;
    else if (ch === '"') return i + 1;
    else i++;
  }
  throw new Error("package.json contains an unterminated string");
}

/**
 * 找出根对象里顶层 "version" 字段的字符串区间。不能只正则匹配第一个
 * `"version"`，因为 overrides/bin 之类的嵌套对象里可能先出现同名（甚至同值）
 * 字段，改错就会静默发布另一个版本号。
 */
function findTopLevelVersion(text) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      const end = scanStringEnd(text, start);
      // depth 1 = 直接挂在根对象上的属性；嵌套字段的 depth >= 2
      if (depth === 1) {
        let j = end;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === ":" && JSON.parse(text.slice(start, end)) === "version") {
          j++;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (text[j] !== '"') throw new Error("package.json has a non-string top-level version");
          return { start: j, end: scanStringEnd(text, j) };
        }
      }
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    i++;
  }
  return undefined;
}

/** 只替换顶层 version 字段的字符串，其余文本（含用户的未提交编辑）逐字保留 */
function withVersion(text, oldVersion, newVersion) {
  const field = findTopLevelVersion(text);
  if (!field) throw new Error('package.json has no top-level "version" field to update.');
  if (JSON.parse(text.slice(field.start, field.end)) !== oldVersion) {
    throw new Error(
      `package.json version is not ${oldVersion}; set it to ${newVersion} by hand and re-run.`,
    );
  }
  const updated = text.slice(0, field.start) + JSON.stringify(newVersion) + text.slice(field.end);
  if (JSON.parse(updated).version !== newVersion) {
    throw new Error(
      `Refusing to write the version: package.json would not parse as ${newVersion}.`,
    );
  }
  return updated;
}

/** 发布前把能安全预判的 --commit 错误拦下，别等不可逆的 publish 之后才暴露 */
function preflightGit(version) {
  const tag = `v${version}`;
  const inWorkTree = git(["rev-parse", "--is-inside-work-tree"]);
  if (inWorkTree.status !== 0 || inWorkTree.stdout !== "true") {
    throw new Error("--commit needs a git work tree, but this directory is not inside one.");
  }
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.status !== 0 || head.stdout === "") {
    throw new Error("--commit needs a commit to build on; HEAD does not exist yet.");
  }
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.status !== 0 || branch.stdout === "") {
    throw new Error("--commit pushes the checked out branch, but HEAD is detached.");
  }
  const remote = git(["remote", "get-url", "origin"]);
  if (remote.status !== 0 || remote.stdout === "") {
    throw new Error("--commit pushes to `origin`, but no origin remote is configured.");
  }
  if (git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).status === 0) {
    throw new Error(`Tag ${tag} already exists; remove or move it before releasing ${version}.`);
  }
  const identity = git(["var", "GIT_COMMITTER_IDENT"]);
  if (identity.status !== 0 || identity.stdout === "") {
    throw new Error(
      '--commit needs a git identity: set user.name and user.email (git config --global user.email "you@example.com").',
    );
  }
  const staged = git(["diff", "--cached", "--name-only"]);
  if (staged.status !== 0) {
    throw new Error("Could not read the git index.");
  }
  if (staged.stdout !== "") {
    throw new Error(
      `--commit refuses to release with staged changes: the release commit would swallow\n` +
        `  ${staged.stdout.split("\n").join("\n  ")}\n` +
        `Commit or unstage them first (\`git restore --staged <path>\`). Unstaged edits are fine.`,
    );
  }
  return { branch: branch.stdout, tag }; // remote URL 可能带 userinfo 凭据，不外传
}

/** 发布后的 git 同步：任何失败都不回退版本，只打印剩下的步骤供手动收尾 */
function syncGit(version) {
  const tag = `v${version}`;
  let commitDone = false;
  let tagDone = false;
  try {
    run("git add package.json");
    const staged = git(["diff", "--cached", "--name-only", "HEAD"])
      .stdout.split("\n")
      .filter(Boolean);
    const extra = staged.filter((file) => file !== "package.json");
    if (extra.length > 0) {
      throw new Error(
        `Unexpected staged files appeared during the release: ${extra.join(", ")}. Nothing was committed.`,
      );
    }
    if (staged.length === 0) {
      console.log("\n(package.json already matches HEAD, skipping the empty version-bump commit)");
    } else {
      run(`git commit -m "chore: bump version to ${version}"`);
    }
    commitDone = true;
    run(`git tag -a ${tag} -m "${tag}"`);
    tagDone = true;
    run(`git push --atomic origin HEAD refs/tags/${tag}`);
  } catch (err) {
    const remaining = [];
    if (!commitDone) {
      remaining.push("  git add package.json");
      remaining.push(`  git commit -m "chore: bump version to ${version}"`);
    }
    if (!tagDone) remaining.push(`  git tag -a ${tag} -m "${tag}"`);
    remaining.push(`  git push --atomic origin HEAD refs/tags/${tag}`);
    throw new Error(
      `${err.message}\n\n${version} is already on npm, so package.json keeps that version.\n` +
        `Finish the git sync manually:\n${remaining.join("\n")}`,
    );
  }
  console.log(`\n✓ Committed, annotated ${tag} and pushed branch + tag to origin`);
}

// 发布前确认；stdin 提前结束（CI/管道 EOF）时 question 的回调永不触发，
// Node 会以 unsettled top-level await (exit 13) 收场，故监听 close 强制
// 按拒绝处理；无 --yes 时无人值守场景永远中止，避免误发布。
async function confirmPublish(newVersion) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`Publish ${newVersion} to npm? [y/N] `, resolve);
    rl.on("close", () => resolve(""));
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function main() {
  const parsed = parseReleaseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(RELEASE_USAGE);
    process.exitCode = 0;
    return;
  }
  if (parsed.kind === "error") {
    console.error(`error: ${parsed.message}\n\n${RELEASE_USAGE}`);
    process.exitCode = 1;
    return;
  }
  const { target, shouldCommit, dryRun, assumeYes } = parsed.plan;

  const { text: pkgText, data: pkg } = readPkg();
  const oldVersion = pkg.version;
  const newVersion = bumpVersion(oldVersion, target);
  const willBump = oldVersion !== newVersion;

  console.log(`\n@whiter001/vue-tsc-files: ${oldVersion} -> ${newVersion}`);
  if (!willBump) {
    console.log("(version unchanged, skipping bump)");
  }

  // 预检只读且 dry-run 共用，预览到的就是会执行的前置条件
  const gitPreflight = shouldCommit ? preflightGit(newVersion) : undefined;
  if (gitPreflight) {
    console.log(
      `git preflight: branch ${gitPreflight.branch}, origin configured, tag ${gitPreflight.tag} free, nothing staged`,
    );
  }

  if (dryRun) {
    const steps = [];
    if (willBump) steps.push(`write version ${newVersion} to package.json`);
    steps.push("pnpm publish --no-git-checks");
    if (gitPreflight) {
      steps.push(`git add package.json`);
      steps.push(
        `git commit -m "chore: bump version to ${newVersion}" (skipped when package.json has no change)`,
      );
      steps.push(`git tag -a ${gitPreflight.tag} -m "${gitPreflight.tag}"`);
      steps.push(`git push --atomic origin HEAD refs/tags/${gitPreflight.tag}`);
    }
    console.log(`dry-run: would ${steps.join(", then would ")}. No changes made.`);
    process.exitCode = 0;
    return;
  }

  // dry-run 已在 whoami 之前结束：预览计划不依赖网络与 npm 登录态
  console.log(`npm user: ${npmWhoAmI(pkg.publishConfig?.registry)}\n`);

  if (!assumeYes && !(await confirmPublish(newVersion))) {
    console.log("Aborted. Nothing published, package.json untouched.");
    process.exitCode = 1;
    return;
  }

  if (willBump) {
    writeFileSync(PKG_PATH, withVersion(pkgText, oldVersion, newVersion));
  }

  let published = false;
  try {
    run("pnpm publish --no-git-checks");
    published = true;
    console.log(`\n✓ Published ${newVersion} to npm`);
    if (gitPreflight) syncGit(newVersion);
  } catch (err) {
    // 已发布的版本号回退会与 npm 记录矛盾，只有 publish 失败才逐字还原
    if (willBump && !published) {
      writeFileSync(PKG_PATH, pkgText);
      console.log(`\n↺ Restored package.json to its original ${oldVersion} content`);
    }
    throw err;
  }
}

// 正常返回让 Node 自己收尾（process.exit 可能截断管道里的输出）
try {
  await main();
} catch (err) {
  console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
