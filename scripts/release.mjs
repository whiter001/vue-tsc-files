#!/usr/bin/env node
// One-shot npm release: bump version -> build -> publish -> optional git sync.
//
// Usage:
//   node scripts/release.mjs                       # patch bump of current version
//   node scripts/release.mjs patch|minor|major    # semantic bump
//   node scripts/release.mjs 1.3.1                # explicit target version
//   node scripts/release.mjs --commit             # also commit + push version bump
//
// Notes:
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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");

const rawArgs = process.argv.slice(2);
const shouldCommit = rawArgs.includes("--commit");
const kind = rawArgs.find((a) => !a.startsWith("--")) || "patch";

function bumpVersion(current, target) {
  if (/^\d+\.\d+\.\d+$/.test(target)) return target;
  const [maj, min, pat] = current.split(".").map(Number);
  if (target === "major") return `${maj + 1}.0.0`;
  if (target === "minor") return `${maj}.${min + 1}.0`;
  if (target === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Invalid version: ${target}. Use major|minor|patch|<x.y.z>.`);
}

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
    throw new Error(`Not logged in to npm (${registry ?? "default registry"}). Run \`npm login\` first.`);
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

const pkg = readPkg();
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, kind);
const willBump = oldVersion !== newVersion;

console.log(`\n@whiter001/vue-tsc-files: ${oldVersion} -> ${newVersion}`);
if (!willBump) {
  console.log("(version unchanged, skipping bump)");
}
console.log(`npm user: ${npmWhoAmI(pkg.publishConfig?.registry)}\n`);

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
