import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getTscFiles, getDtsFiles, randomChars, setupArgs } from "../src/util.ts";

/** 在替换 process.argv 的上下文中调用 setupArgs */
function withArgv(args: string[], fn: () => void) {
  const original = process.argv;
  process.argv = [original[0], original[1], ...args];
  try {
    fn();
  } finally {
    process.argv = original;
  }
}

test("getTscFiles 只保留 ts/tsx/vue/mts/cts 文件", () => {
  const files = getTscFiles([
    "a.ts",
    "b.tsx",
    "c.vue",
    "d.mts",
    "e.cts",
    "f.js",
    "tsconfig.json",
    "--noEmit",
  ]);
  assert.deepEqual(files, ["a.ts", "b.tsx", "c.vue", "d.mts", "e.cts"]);
});

test("randomChars 生成不重复的随机后缀", () => {
  const values = new Set(Array.from({ length: 100 }, () => randomChars()));
  assert.equal(values.size, 100);
});

test("getDtsFiles 跳过 node_modules、dot 目录和构建产物目录", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-dts-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "src", "a.d.ts"), "");
    writeFileSync(join(root, "node_modules/pkg", "b.d.ts"), "");
    writeFileSync(join(root, "dist", "c.d.ts"), "");
    writeFileSync(join(root, ".git", "d.d.ts"), "");

    const found = getDtsFiles(root);
    assert.deepEqual(found, [`${root}/src/a.d.ts`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setupArgs 正确解析 -p，文件参数在 -p 之前时不错位", () => {
  withArgv(["src/a.ts", "-p", "tsconfig.app.json"], () => {
    const { files, projectValue, remainingArgsToForward } = setupArgs();
    assert.equal(projectValue, "tsconfig.app.json");
    assert.ok(files.includes("src/a.ts"));
    // -p 及其值不能残留在转发参数里
    assert.ok(!remainingArgsToForward.includes("-p"));
    assert.ok(!remainingArgsToForward.includes("tsconfig.app.json"));
  });
});

test("setupArgs 正确解析 --project 长参数", () => {
  withArgv(["--project", "tsconfig.app.json", "src/a.ts"], () => {
    const { projectValue, remainingArgsToForward } = setupArgs();
    assert.equal(projectValue, "tsconfig.app.json");
    assert.deepEqual(remainingArgsToForward, []);
  });
});

test("setupArgs 转发其他 flag，剔除文件参数", () => {
  withArgv(["src/a.ts", "--noEmit", "src/b.vue"], () => {
    const { remainingArgsToForward } = setupArgs();
    assert.deepEqual(remainingArgsToForward, ["--noEmit"]);
  });
});
