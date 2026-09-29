import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join } from "path";
import {
  getTscFiles,
  randomChars,
  setupArgs,
  createAndSetupTsConfig,
  filterErrorsInFiles,
  stripAnsiCodes,
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

test("setupArgs 支持 --project=path 与 -p=path 连写", () => {
  for (const arg of ["--project=tsconfig.app.json", "-p=tsconfig.app.json"]) {
    withArgv([arg, "src/a.ts"], () => {
      const { projectValue, remainingArgsToForward } = setupArgs();
      assert.equal(projectValue, "tsconfig.app.json");
      assert.deepEqual(remainingArgsToForward, []);
    });
  }
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

test("filterErrorsInFiles 支持 --pretty 格式（path:line:col - error）", () => {
  const output = [
    "src/changed.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "",
    "1 const a: number = 'x';",
    "        ~",
    "src/dep.ts:2:3 - error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join("\n");

  const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(output, ["src/changed.ts"]);
  assert.equal(errorsInSpecifiedFiles.length, 1);
  assert.match(errorsInSpecifiedFiles[0], /src\/changed\.ts/);
  assert.deepEqual(globalErrors, []);
});

test("filterErrorsInFiles 去除 ANSI 色码后再归属（--pretty 彩色输出）", () => {
  // tsc --pretty 的真实输出：路径、行列号和 error TSxxxx 都带 SGR 色码
  const output =
    "\x1b[96msrc/changed.ts\x1b[0m:\x1b[93m1\x1b[0m:\x1b[93m7\x1b[0m - " +
    "\x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'string' is not assignable to type 'number'.\n" +
    "\x1b[96msrc/dep.ts\x1b[0m:\x1b[93m2\x1b[0m:\x1b[93m3\x1b[0m - " +
    "\x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'string' is not assignable to type 'number'.";

  const { errorsInSpecifiedFiles } = filterErrorsInFiles(output, ["src/changed.ts"]);
  assert.equal(errorsInSpecifiedFiles.length, 1);
  assert.match(stripAnsiCodes(errorsInSpecifiedFiles[0]), /src\/changed\.ts/);
});

test("stripAnsiCodes 去除 SGR 序列，保留文本内容", () => {
  assert.equal(stripAnsiCodes("\x1b[91merror\x1b[0m TS2322"), "error TS2322");
  assert.equal(stripAnsiCodes("plain text"), "plain text");
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

test("createAndSetupTsConfig 按 tsconfig 范围收集 d.ts、尊重用户 skipLibCheck、tmp 配置与原配置同目录", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-cfg-"));
  const prevCwd = process.cwd();
  let tmpPath: string | undefined;
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: false },
        include: ["src"],
      }),
    );
    writeFileSync(join(root, "src", "env.d.ts"), "declare const inScope: number;\n");
    writeFileSync(join(root, "stray.d.ts"), "declare const outOfScope: number;\n");

    process.chdir(root);
    try {
      tmpPath = createAndSetupTsConfig(["src/good.ts"]);
    } finally {
      process.chdir(prevCwd);
    }

    const config = JSON.parse(readFileSync(tmpPath, "utf8"));
    const fileNames = config.files.map((f: string) => f.replace(/\\/g, "/"));

    // #6：用户显式的 skipLibCheck:false 不被强制覆盖
    assert.equal(config.compilerOptions.skipLibCheck, false);
    // #7：只收集 tsconfig include 范围内的 d.ts
    assert.ok(fileNames.some((f: string) => f.endsWith("src/env.d.ts")));
    assert.ok(!fileNames.some((f: string) => f.endsWith("stray.d.ts")));
    // #1：files 统一为绝对路径，tmp 配置与原 tsconfig 同目录
    assert.ok(config.files.every((f: string) => isAbsolute(f)));
    assert.equal(dirname(tmpPath), root);
  } finally {
    process.chdir(prevCwd);
    if (tmpPath) rmSync(tmpPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("createAndSetupTsConfig 未设置 skipLibCheck 时默认开启", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-cfg-"));
  const prevCwd = process.cwd();
  let tmpPath: string | undefined;
  try {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));

    process.chdir(root);
    try {
      tmpPath = createAndSetupTsConfig(["good.ts"]);
    } finally {
      process.chdir(prevCwd);
    }

    const config = JSON.parse(readFileSync(tmpPath, "utf8"));
    assert.equal(config.compilerOptions.skipLibCheck, true);
  } finally {
    process.chdir(prevCwd);
    if (tmpPath) rmSync(tmpPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
