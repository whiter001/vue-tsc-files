import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { RELEASE_USAGE, bumpVersion, parseReleaseArgs } from "../scripts/release-args.ts";

test("parseReleaseArgs 无参数时默认 patch，不触发任何 flag", () => {
  assert.deepEqual(parseReleaseArgs([]), {
    kind: "plan",
    plan: { target: "patch", shouldCommit: false, dryRun: false, assumeYes: false },
  });
});

test("parseReleaseArgs 接受 major/minor/patch 和显式 x.y.z", () => {
  for (const target of ["major", "minor", "patch", "1.4.0", "2.0.0"]) {
    const parsed = parseReleaseArgs([target]);
    assert.equal(parsed.kind, "plan");
    assert.equal(parsed.kind === "plan" ? parsed.plan.target : undefined, target);
  }
});

test("parseReleaseArgs 组合 --commit/--dry-run/--yes", () => {
  const parsed = parseReleaseArgs(["1.4.0", "--commit", "--dry-run", "--yes"]);
  assert.deepEqual(parsed, {
    kind: "plan",
    plan: { target: "1.4.0", shouldCommit: true, dryRun: true, assumeYes: true },
  });
});

test("parseReleaseArgs -h/--help 返回 help", () => {
  assert.deepEqual(parseReleaseArgs(["-h"]), { kind: "help" });
  assert.deepEqual(parseReleaseArgs(["--help"]), { kind: "help" });
});

test("parseReleaseArgs 未知 flag 报错而不是回退默认 patch（#16 回归）", () => {
  for (const argv of [["--help-me"], ["--bogus"], ["--dry"], ["-x"], ["--bogus", "patch"]]) {
    const parsed = parseReleaseArgs(argv);
    assert.equal(parsed.kind, "error", `expected error for ${JSON.stringify(argv)}`);
    assert.match(parsed.kind === "error" ? parsed.message : "", /Unknown option/);
  }
});

test("parseReleaseArgs 多个位置参数报错", () => {
  const parsed = parseReleaseArgs(["minor", "1.4.0"]);
  assert.equal(parsed.kind, "error");
  assert.match(parsed.kind === "error" ? parsed.message : "", /at most one/);
});

test("parseReleaseArgs 非法版本目标报错", () => {
  for (const argv of [["next"], ["1.2"], ["v1.4.0"], ["1.4.0.0"]]) {
    const parsed = parseReleaseArgs(argv);
    assert.equal(parsed.kind, "error", `expected error for ${JSON.stringify(argv)}`);
    assert.match(parsed.kind === "error" ? parsed.message : "", /Invalid version target/);
  }
});

test("RELEASE_USAGE 提及全部选项", () => {
  for (const needle of ["--dry-run", "--commit", "--yes", "--help"]) {
    assert.ok(RELEASE_USAGE.includes(needle));
  }
});

test("bumpVersion 语义化升级", () => {
  assert.equal(bumpVersion("1.3.3", "patch"), "1.3.4");
  assert.equal(bumpVersion("1.3.3", "minor"), "1.4.0");
  assert.equal(bumpVersion("1.3.3", "major"), "2.0.0");
  assert.equal(bumpVersion("0.0.9", "patch"), "0.0.10");
});

test("bumpVersion 显式版本原样返回", () => {
  assert.equal(bumpVersion("1.3.3", "1.4.0"), "1.4.0");
});

test("bumpVersion 非法目标或非法当前版本抛错", () => {
  assert.throws(() => bumpVersion("1.3.3", "next"), /Invalid version/);
  assert.throws(() => bumpVersion("1.3", "patch"), /not valid semver/);
  assert.throws(() => bumpVersion("x.y.z", "patch"), /not valid semver/);
});

test("parseReleaseArgs 拒绝带前导零的版本（npm publish 会拒收）", () => {
  for (const argv of [["01.4.0"], ["1.04.0"], ["1.4.00"]]) {
    const parsed = parseReleaseArgs(argv);
    assert.equal(parsed.kind, "error", `expected error for ${JSON.stringify(argv)}`);
    assert.match(parsed.kind === "error" ? parsed.message : "", /Invalid version target/);
  }
  assert.throws(() => bumpVersion("1.3.3", "01.4.0"), /Invalid version/);
});

test("parseReleaseArgs 处理 -、-- 与空串参数", () => {
  // 单横线、双横线、空串都不是合法目标或选项
  const dash = parseReleaseArgs(["-"]);
  assert.equal(dash.kind, "error");
  assert.match(dash.kind === "error" ? dash.message : "", /Unknown option: -$/);
  const doubleDash = parseReleaseArgs(["--"]);
  assert.equal(doubleDash.kind, "error");
  const empty = parseReleaseArgs([""]);
  assert.equal(empty.kind, "error");
  assert.match(empty.kind === "error" ? empty.message : "", /Invalid version target/);
});

test("parseReleaseArgs help 与未知 flag 的优先级取决于出现顺序", () => {
  const bogusFirst = parseReleaseArgs(["--bogus", "--help"]);
  assert.equal(bogusFirst.kind, "error");
  const helpFirst = parseReleaseArgs(["--help", "--bogus"]);
  assert.deepEqual(helpFirst, { kind: "help" });
});

test("release.mjs 真实 spawn 下未知 flag 不触发发布且不改版本（#16 端到端回归）", () => {
  // 沙箱化：registry 指向不可达地址——即使解析逻辑未来回归成默认 patch，
  // 脚本也会在 whoami 阶段失败退出，触达不了真实 registry 或版本写入
  const dir = mkdtempSync(join(tmpdir(), "release-smoke-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir);
  copyFileSync(
    fileURLToPath(new URL("../scripts/release.mjs", import.meta.url)),
    join(scriptsDir, "release.mjs"),
  );
  copyFileSync(
    fileURLToPath(new URL("../scripts/release-args.ts", import.meta.url)),
    join(scriptsDir, "release-args.ts"),
  );
  const pkgPath = join(dir, "package.json");
  writeFileSync(
    pkgPath,
    JSON.stringify({
      name: "release-smoke-sandbox",
      version: "9.9.9",
      type: "module",
      publishConfig: { registry: "http://127.0.0.1:1/" },
    }),
  );
  try {
    const r = spawnSync(process.execPath, [join(scriptsDir, "release.mjs"), "--bogus"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    assert.equal(r.status, 1);
    assert.match(output, /Unknown option/);
    assert.doesNotMatch(output, /Published/);
    assert.equal(JSON.parse(readFileSync(pkgPath, "utf8")).version, "9.9.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
