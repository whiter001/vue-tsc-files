import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getTscFiles,
  getDtsFiles,
  randomChars,
  setupArgs,
  filterErrorsInFiles,
  parseGitStatusPorcelain,
} from "../src/util.ts";

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

test("setupArgs 解析 --errors-in-changed-only 及别名，且不转发给 vue-tsc", () => {
  for (const flag of ["--errors-in-changed-only", "--changed-only"]) {
    withArgv(["src/a.ts", flag], () => {
      const { errorsInChangedOnly, specifiedFiles, remainingArgsToForward } = setupArgs();
      assert.equal(errorsInChangedOnly, true);
      assert.deepEqual(specifiedFiles, ["src/a.ts"]);
      assert.ok(!remainingArgsToForward.includes(flag));
    });
  }
});

test("setupArgs 未传 flag 时 errorsInChangedOnly 为 false", () => {
  withArgv(["src/a.ts"], () => {
    const { errorsInChangedOnly } = setupArgs();
    assert.equal(errorsInChangedOnly, false);
  });
});

test("filterErrorsInFiles 只保留指定文件的错误，忽略传递依赖的错误", () => {
  const output = [
    "src/changed.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/dep.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join("\n");

  const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(output, ["src/changed.ts"]);
  assert.equal(errorsInSpecifiedFiles.length, 1);
  assert.match(errorsInSpecifiedFiles[0], /src\/changed\.ts/);
  assert.deepEqual(globalErrors, []);
});

test("filterErrorsInFiles 中 ./ 前缀和相对路径写法等价", () => {
  const output = "src/a.ts(1,1): error TS2322: x";
  const { errorsInSpecifiedFiles } = filterErrorsInFiles(output, ["./src/a.ts"]);
  assert.equal(errorsInSpecifiedFiles.length, 1);
});

test("filterErrorsInFiles 兼容含空格及单引号包裹的路径", () => {
  const spaced = "src/foo bar.ts(1,7): error TS2322: x";
  assert.equal(filterErrorsInFiles(spaced, ["src/foo bar.ts"]).errorsInSpecifiedFiles.length, 1);

  // 防御性格式：部分 formatter 会给含空格路径加单引号
  const quoted = "'src/foo bar.ts'(1,7): error TS2322: x";
  assert.equal(filterErrorsInFiles(quoted, ["src/foo bar.ts"]).errorsInSpecifiedFiles.length, 1);
});

test("filterErrorsInFiles 收集无文件位置的全局错误", () => {
  const output = "error TS5083: Cannot read file 'tsconfig.json'.";
  const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(output, ["src/a.ts"]);
  assert.deepEqual(errorsInSpecifiedFiles, []);
  assert.equal(globalErrors.length, 1);
});

test("parseGitStatusPorcelain 解析各类变更状态，跳过删除文件和重命名旧路径", () => {
  const output =
    [
      " M src/a.ts",
      "M  src/b.vue",
      "A  src/c.tsx",
      "?? src/d.vue",
      "D  src/e.ts",
      "R  src/new.ts",
      "src/old.ts",
      "UU src/f.ts",
    ].join("\0") + "\0";

  assert.deepEqual(parseGitStatusPorcelain(output), [
    "src/a.ts",
    "src/b.vue",
    "src/c.tsx",
    "src/d.vue",
    "src/new.ts",
    "src/f.ts",
  ]);
});

test("parseGitStatusPorcelain 空输出返回空数组", () => {
  assert.deepEqual(parseGitStatusPorcelain(""), []);
});
