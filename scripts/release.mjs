#!/usr/bin/env node
// One-shot npm release: bump version -> build -> publish -> optional git sync.
//
// Usage: see RELEASE_USAGE (also printed by --help).
//
// Notes:
// - Unknown flags or targets abort with usage instead of silently falling back
//   to a default patch release (issue #16: `--help` used to start a publish).
// - A confirmation prompt guards the real publish; --yes skips it.
// - Skips the version bump when the target equals the current version.
// - Runs `pnpm publish --no-git-checks`, which triggers `prepublishOnly` -> `pnpm build`.
//   --no-git-checks skips pnpm's own git cleanliness check so the script
//   works even when the working tree has uncommitted local edits (e.g. a
//   release script that hasn't been committed yet).
// - Publish registry is pinned via package.json `publishConfig.registry`,
//   so the script doesn't have to know about the user's default registry
//   (commonly a read-only mirror like registry.npmmirror.com).
// - Reverts the local version edit if publish fails, so the working tree stays clean.
// - Does NOT touch git unless --commit is passed.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RELEASE_USAGE, bumpVersion, parseReleaseArgs } from "./release-args.ts";

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

function readPkg() {
  return JSON.parse(readFileSync(PKG_PATH, "utf8"));
}

function writePkg(pkg) {
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
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

const parsed = parseReleaseArgs(process.argv.slice(2));
if (parsed.kind === "help") {
  console.log(RELEASE_USAGE);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`error: ${parsed.message}\n\n${RELEASE_USAGE}`);
  process.exit(1);
}
const { target, shouldCommit, dryRun, assumeYes } = parsed.plan;

const pkg = readPkg();
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, target);
const willBump = oldVersion !== newVersion;

console.log(`\n@whiter001/vue-tsc-files: ${oldVersion} -> ${newVersion}`);
if (!willBump) {
  console.log("(version unchanged, skipping bump)");
}
console.log(`npm user: ${npmWhoAmI(pkg.publishConfig?.registry)}\n`);

if (dryRun) {
  const steps = [];
  if (willBump) steps.push(`write version ${newVersion} to package.json`);
  steps.push("pnpm publish --no-git-checks");
  if (shouldCommit && willBump) {
    steps.push(
      `git add package.json && git commit -m "chore: bump version to ${newVersion}" && git tag v${newVersion} && git push origin HEAD --follow-tags`,
    );
  }
  console.log(`dry-run: would ${steps.join(", then would ")}. No changes made.`);
  process.exit(0);
}

if (!assumeYes && !(await confirmPublish(newVersion))) {
  console.log("Aborted. Nothing published, package.json untouched.");
  process.exit(1);
}

if (willBump) {
  pkg.version = newVersion;
  writePkg(pkg);
}

let committed = false;
try {
  run("pnpm publish --no-git-checks");
  console.log(`\n✓ Published ${newVersion} to npm`);

  if (shouldCommit && willBump) {
    run("git add package.json");
    run(`git commit -m "chore: bump version to ${newVersion}"`);
    committed = true;
    run(`git tag v${newVersion}`);
    // push 当前分支（含 tag），不硬编码 master
    run("git push origin HEAD --follow-tags");
    console.log("\n✓ Committed, tagged and pushed version bump");
  }
} catch (err) {
  // 已 commit 的版本号不能回退（否则工作区与提交记录产生伪差异）；
  // 仅在尚未 commit 时还原 package.json
  if (willBump && !committed) {
    pkg.version = oldVersion;
    writePkg(pkg);
    console.log(`\n↺ Reverted package.json to ${oldVersion}`);
  }
  throw err;
}
