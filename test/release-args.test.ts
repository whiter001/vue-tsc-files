import { test } from "node:test";
import assert from "node:assert/strict";
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
