import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  lstatSync,
  statSync,
  linkSync,
  realpathSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { stripAnsiCodes } from "../src/util.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "vue-tsc-files");

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true },
});

/** 创建独立的临时 fixture 项目（tsconfig + 源文件），避免污染真实仓库 */
function createFixture(files: Record<string, string>, root?: string) {
  const dir = root ?? mkdtempSync(join(tmpdir(), "vtf-it-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/** 创建已提交基线的 git fixture，之后的文件改动即为"变更" */
function createGitFixture(files: Record<string, string>, root?: string) {
  const dir = createFixture(files, root);
  git(dir, ["init", "-q"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "init"]);
  return dir;
}

test("类型错误文件退出码非 0 并输出诊断", () => {
  const root = createFixture({
    "bad.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    const result = runCli(root, ["bad.ts"]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("正常文件退出码为 0", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    const result = runCli(root, ["good.ts"]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-p 显式指定 tsconfig，文件参数在 -p 之前也正常", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    const result = runCli(root, ["good.ts", "-p", "tsconfig.json"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 忽略传递依赖文件的错误", () => {
  const root = createFixture({
    "good.ts": 'import a from "./dep";\nexport default a;\n',
    "dep.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    const result = runCli(root, ["--errors-in-changed-only", "good.ts"]);
    assert.equal(result.status, 0, result.stderr);
    // 依赖文件的错误仍原样展示，但不影响退出码
    assert.match(result.stdout, /dep\.ts.*error TS2322/);
    assert.match(result.stderr, /--errors-in-changed-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 下指定文件自身的错误仍以非 0 退出", () => {
  const root = createFixture({
    "bad.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    const result = runCli(root, ["--errors-in-changed-only", "bad.ts"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--changed-only 别名端到端生效", () => {
  const root = createFixture({
    "good.ts": 'import a from "./dep";\nexport default a;\n',
    "dep.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    const result = runCli(root, ["--changed-only", "good.ts"]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 多个指定文件只有部分有错时按非 0 退出", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "bad.ts": 'const b: number = "x";\nexport default b;\n',
  });
  try {
    const result = runCli(root, ["--errors-in-changed-only", "good.ts", "bad.ts"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /bad\.ts.*error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 支持含空格的文件路径", () => {
  const root = createFixture({
    "src/foo bar.ts": 'import a from "./my dep";\nexport default a;\n',
    "src/my dep.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    // 含空格的依赖文件错误被忽略
    const ignored = runCli(root, ["--errors-in-changed-only", "src/foo bar.ts"]);
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.match(ignored.stdout, /my dep\.ts.*error TS2322/);

    // 含空格的指定文件自身错误仍然算数
    const counted = runCli(root, ["--errors-in-changed-only", "src/my dep.ts"]);
    assert.notEqual(counted.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 下文件名前导空格不被 trim，目标文件自身错误仍失败", () => {
  const sfc = (body: string) =>
    `<template><div/></template>\n<script lang="ts">\n${body}</script>\n`;
  const root = createFixture({
    " good.ts": 'import a from "./ bad";\nexport default a;\n',
    " bad.ts": 'const a: number = "x";\nexport default a;\n',
    " good.vue": sfc('import a from "./ bad";\nexport default a;\n'),
    " bad.vue": sfc('const a: number = "x";\nexport default a;\n'),
  });
  try {
    // 依赖错误仍按传递依赖豁免
    for (const good of [" good.ts", " good.vue"]) {
      const ignored = runCli(root, ["--errors-in-changed-only", good]);
      assert.equal(ignored.status, 0, ignored.stderr);
      assert.match(ignored.stdout, /error TS2322/);
    }

    // 目标文件自身（前导空格文件名）必须失败，不能被当成依赖错误放行
    const countedTs = runCli(root, ["--errors-in-changed-only", " bad.ts"]);
    assert.equal(countedTs.status, 2, countedTs.stdout + countedTs.stderr);
    assert.match(countedTs.stdout, / bad\.ts\(\d+,\d+\): error TS2322/);

    const countedVue = runCli(root, ["--errors-in-changed-only", " bad.vue"]);
    assert.equal(countedVue.status, 2, countedVue.stdout + countedVue.stderr);
    assert.match(countedVue.stdout, / bad\.vue\(\d+,\d+\): error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 转发 --pretty 时错误归属仍然正确", () => {
  const root = createFixture({
    "good.ts": 'import a from "./dep";\nexport default a;\n',
    "dep.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    // 传递依赖的错误在 --pretty 输出格式下同样被忽略
    const lenient = runCli(root, ["--errors-in-changed-only", "--pretty", "good.ts"]);
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stderr, /--errors-in-changed-only/);

    // 指定文件自身的错误在 --pretty 下仍然算数
    const strict = runCli(root, ["--errors-in-changed-only", "--pretty", "dep.ts"]);
    assert.notEqual(strict.status, 0);
    assert.match(stripAnsiCodes(strict.stdout), /error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-p 指向子目录 tsconfig 时 extends 相对路径正常解析", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "configs/base.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "configs/tsconfig.json": JSON.stringify({ extends: "./base.json" }),
  });
  try {
    const result = runCli(root, ["good.ts", "-p", "configs/tsconfig.json"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    // 子目录里的临时配置也被清理
    const leftovers = readdirSync(join(root, "configs")).filter((f) =>
      /^tsconfig\..+\.json$/.test(f),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-p 缺少路径参数时给出错误提示并以 1 退出", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    const result = runCli(root, ["good.ts", "-p"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a tsconfig path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-p/--project 传目录时读取其中的 tsconfig.json", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    const dashP = runCli(root, ["good.ts", "-p", "."]);
    assert.equal(dashP.status, 0, dashP.stderr + dashP.stdout);

    const joined = runCli(root, ["good.ts", "--project=."]);
    assert.equal(joined.status, 0, joined.stderr + joined.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-p 指向的目录里没有 tsconfig.json 时报错并以 1 退出", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-it-"));
  writeFileSync(join(root, "good.ts"), "export default 1;\n");
  try {
    const result = runCli(root, ["good.ts", "-p", "."]);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /Failed to read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("用户显式 skipLibCheck:false 时不被强制覆盖", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    // 声明文件内的错误只有 skipLibCheck:false 时才会被检查出来
    "bad.d.ts": "type T = NotDefined;\n",
  });
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false } }),
    );
    const result = runCli(root, ["good.ts"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /error TS2304/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 下非法 compilerOptions 的 tsconfig 仍失败（普通/pretty 输出）", () => {
  for (const extra of [[], ["--pretty"]]) {
    const root = createFixture({
      "good.ts": "const a: number = 1;\nexport default a;\n",
    });
    try {
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: "nope" } }),
      );
      const result = runCli(root, ["--errors-in-changed-only", ...extra, "good.ts"]);
      assert.notEqual(
        result.status,
        0,
        `args: ${JSON.stringify(extra)} stdout: ${result.stdout} stderr: ${result.stderr}`,
      );
      assert.match(stripAnsiCodes(result.stdout + result.stderr), /error TS5024/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("--errors-in-changed-only 下 extends 链上游配置里的非法选项仍失败", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "base.json": JSON.stringify({ compilerOptions: { notARealOption: true } }),
  });
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ extends: "./base.json", compilerOptions: { strict: true } }),
    );
    const result = runCli(root, ["--errors-in-changed-only", "good.ts"]);
    assert.notEqual(result.status, 0);
    // 诊断落在非受支持的 base.json 上，保守归为全局错误而非按依赖豁免
    assert.match(stripAnsiCodes(result.stdout + result.stderr), /base\.json.*error TS5023/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("原配置非法 tsBuildInfoFile 在 override 之前失败（普通/pretty）", () => {
  for (const tsBuildInfoFile of [123, false]) {
    for (const extra of [[], ["--pretty"]]) {
      const root = createFixture({
        "good.ts": "const a: number = 1;\nexport default a;\n",
      });
      try {
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: { strict: true, incremental: true, tsBuildInfoFile },
          }),
        );
        const result = runCli(root, ["--errors-in-changed-only", ...extra, "good.ts"]);
        assert.notEqual(
          result.status,
          0,
          `tsBuildInfoFile: ${tsBuildInfoFile} args: ${JSON.stringify(extra)}`,
        );
        // 错误指向原配置里的 tsBuildInfoFile，而不是被内部 override 抹掉
        assert.match(
          stripAnsiCodes(result.stdout + result.stderr),
          /error TS5024: Compiler option 'tsBuildInfoFile'/,
        );
        // 提前退出，不应留下任何临时产物
        assert.deepEqual(readdirSyncTmpArtifacts(root), []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("extends 指向 .ts 文件在依赖过滤之前失败（普通/pretty）", () => {
  for (const [base, code] of [
    ["export const base = 1;\n", "TS1005"],
    [JSON.stringify({ compilerOptions: { unknownOption: true } }), "TS5023"],
  ]) {
    for (const extra of [[], ["--pretty"]]) {
      const root = createFixture({
        "good.ts": "const a: number = 1;\nexport default a;\n",
        "base.ts": base!,
      });
      try {
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({ extends: "./base.ts", compilerOptions: { strict: true } }),
        );
        const result = runCli(root, ["--errors-in-changed-only", ...extra, "good.ts"]);
        assert.notEqual(result.status, 0, `args: ${JSON.stringify(extra)}`);
        assert.match(
          stripAnsiCodes(result.stdout + result.stderr),
          new RegExp(`base\\.ts.*error ${code}`),
        );
        assert.deepEqual(readdirSyncTmpArtifacts(root), []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("移除 project 不得改变 option 消费边界、关闭 strict 或吞掉 noEmit", () => {
  const root = createFixture({
    "bad.ts": "export function f(x) { return x; }\n",
    "good.ts": "export const value = 1;\n",
  });
  try {
    for (const args of [
      ["--strict", "-p", "tsconfig.json", "false", "bad.ts"],
      ["--outDir", "-p", "tsconfig.json", "good.ts"],
    ]) {
      const result = runCli(root, args);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /Cannot safely forward compiler options/);
      assert.deepEqual(readdirSyncTmpArtifacts(root), []);
      assert.equal(existsSync(join(root, "--noEmit")), false);
      assert.equal(existsSync(join(root, "good.js")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("响应文件不能覆盖内部 project 或污染用户 buildinfo", () => {
  const root = createFixture({
    "good.ts": "export const value = 1;\n",
    "args.txt": "--project other.json",
    "other.json": JSON.stringify({
      compilerOptions: { incremental: true, tsBuildInfoFile: "user-cache.tsbuildinfo" },
      files: ["good.ts"],
    }),
    "user-cache.tsbuildinfo": "SENTINEL_DO_NOT_TOUCH",
  });
  try {
    for (const args of [
      ["@args.txt", "good.ts"],
      ["--strict", "@args.txt", "good.ts"],
    ]) {
      const result = runCli(root, args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Response-file arguments/);
      assert.equal(
        readFileSync(join(root, "user-cache.tsbuildinfo"), "utf8"),
        "SENTINEL_DO_NOT_TOUCH",
      );
      assert.deepEqual(readdirSyncTmpArtifacts(root), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project 的 @ 开头路径不作响应文件，分写和连写均正常", () => {
  const root = createFixture({
    "good.ts": "export const value = 1;\n",
    "@config.json": JSON.stringify({ compilerOptions: { strict: true } }),
  });
  try {
    for (const args of [["-p", "@config.json"], ["--project=@config.json"]]) {
      const result = runCli(root, [...args, "good.ts"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(readdirSyncTmpArtifacts(root), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Windows 上进程自杀被 libuv 映射为普通退出码（signal 为 null），真实信号组合无法
// 跨平台产生 status:null；用 --require 包装 child_process.spawnSync，让内部那次
// vue-tsc 调用返回"打印依赖样诊断后被信号中断"的结果，走真实 CLI 的中断分支。
const MOCK_INTERRUPTED_SPAWN = `
const cp = require("child_process");
const spawnSync = cp.spawnSync;
cp.spawnSync = function (cmd, args, options) {
  const list = Array.isArray(args) ? args : [];
  if (String(list[0] ?? "").endsWith("vue-tsc.js")) {
    return {
      pid: 0,
      output: null,
      stdout: "dep.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\\n",
      stderr: "",
      status: null,
      signal: "SIGTERM",
    };
  }
  return spawnSync.apply(this, arguments);
};
`;

test("--errors-in-changed-only 下子进程被信号中断时始终失败", () => {
  const root = createFixture({
    "good.ts": "export default 1;\n",
    "mock.cjs": MOCK_INTERRUPTED_SPAWN,
  });
  try {
    const result = spawnSync(
      process.execPath,
      ["--require", join(root, "mock.cjs"), CLI, "--errors-in-changed-only", "good.ts"],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    // 依赖样子的输出原样展示，但不影响"失败"判定
    assert.match(result.stdout, /dep\.ts.*error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--errors-in-changed-only 保留真实子进程中断后的失败状态", () => {
  const root = createFixture({
    "good.ts": "export {};\n",
    ...stubVueTsc(
      'console.log("dep.ts(1,1): error TS2322: x"); process.kill(process.pid, "SIGTERM");',
    ),
  });
  try {
    const result = runCli(root, ["good.ts", "--errors-in-changed-only"]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /dep\.ts.*error TS2322/);
    assert.doesNotMatch(result.stderr, /ignored by/);
    assert.deepEqual(readdirSyncTmpConfigs(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-p 指向以 .ts 结尾的 tsconfig 文件名时按 project 处理并成功", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "configs.ts": JSON.stringify({ compilerOptions: { strict: true } }),
  });
  try {
    const result = runCli(root, ["good.ts", "-p", "configs.ts"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--outDir 以 .ts 结尾的值被 option 消费而非当作源文件", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    // 与 option 值同名的文件：只有被当作检查目标时错误才应暴露
    "dist.ts": 'const broken: number = "x";\nexport default broken;\n',
  });
  try {
    const consumed = runCli(root, ["--outDir", "dist.ts", "good.ts"]);
    assert.equal(consumed.status, 0, consumed.stderr + consumed.stdout);

    const asFile = runCli(root, ["dist.ts"]);
    assert.notEqual(asFile.status, 0);
    assert.match(asFile.stdout, /error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--outDir 消费紧跟的 dash-token，其余源文件照常检查", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    // TS 语义：第一个 --outDir 的值是第二个 --outDir；other.ts 仍是源文件，错误要报
    "other.ts": 'const broken: number = "x";\nexport default broken;\n',
  });
  try {
    const result = runCli(root, ["--outDir", "--outDir", "other.ts", "good.ts"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /other\.ts.*error TS2322/);
    assert.doesNotMatch(result.stdout, /good\.ts\(\d+,\d+\): error/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--strict/--unknown 后的 --help 按 help 处理且不加载 TypeScript", () => {
  // wrapper contract：help 优先于其它转发参数，第一遍扫描即退出（原版行为也是 parse 之前）
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "block.cjs": BLOCK_TYPESCRIPT,
  });
  try {
    for (const args of [
      ["--strict", "--help"],
      ["--unknown", "--help"],
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--require", join(root, "block.cjs"), CLI, ...args],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
      assert.doesNotMatch(result.stdout + result.stderr, /TYPESCRIPT_LOAD_BLOCKED/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--staged --strict --pretty 无目标时不加载 TypeScript 并以 0 退出", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "block.cjs": BLOCK_TYPESCRIPT,
  });
  try {
    // 只有未暂存改动：staged 收集为空，应在任何 TS 加载之前退出
    const result = spawnSync(
      process.execPath,
      ["--require", join(root, "block.cjs"), CLI, "--staged", "--strict", "--pretty"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No staged files/);
    assert.doesNotMatch(result.stdout + result.stderr, /TYPESCRIPT_LOAD_BLOCKED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("显式文件落在原 include 范围之外时仍通过", () => {
  const root = createFixture({
    "outside/explicit.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    // 原配置没有任何输入（1803），但 files/include 会被 wrapper 替换，不算错误
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["nothing-here"] }),
    );
    const result = runCli(root, ["outside/explicit.ts"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缺少 tsconfig 时给出友好提示并以 1 退出", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-it-"));
  writeFileSync(join(root, "good.ts"), "export default 1;\n");
  try {
    const result = runCli(root, ["good.ts"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /Failed to read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("无有效文件参数时以 1 退出并输出用法指引", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "good.js": "export default 1;\n",
  });
  try {
    // 完全没传文件、参数全被扩展名过滤掉、传目录：都是用法错误，
    // 且发生在读取 tsconfig 之前
    for (const args of [[], ["good.js"], ["."]]) {
      const result = runCli(root, args);
      assert.equal(result.status, 1, `args: ${JSON.stringify(args)} ${result.stderr}`);
      assert.match(result.stderr, /No files to check/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--help 与 -h 打印用法并以 0 退出（无需 tsconfig）", () => {
  // 故意使用没有 tsconfig 的目录，验证 help 在读取配置之前生效
  const root = mkdtempSync(join(tmpdir(), "vtf-it-"));
  try {
    for (const flag of ["--help", "-h"]) {
      const result = runCli(root, [flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
      assert.match(result.stdout, /--errors-in-changed-only/);
      assert.match(result.stdout, /--changed/);
      assert.match(result.stdout, /--staged/);
      assert.match(result.stdout, /--unstaged/);
      assert.match(result.stdout, /buildinfo/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("检查结束后临时 tsconfig 文件被清理", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    runCli(root, ["good.ts"]);
    const leftovers = readdirSyncTmpConfigs(root);
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("重复运行 --incremental 使用本次独占 buildinfo 且无残留", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    for (let i = 0; i < 2; i++) {
      const result = runCli(root, ["--incremental", "good.ts"]);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.deepEqual(readdirSyncTmpArtifacts(root), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("用户配置的缓存路径不被写入或删除（buildinfo 重定向到独占临时文件）", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          incremental: true,
          tsBuildInfoFile: "user-cache.tsbuildinfo",
        },
      }),
    );
    writeFileSync(join(root, "user-cache.tsbuildinfo"), "SENTINEL_DO_NOT_TOUCH");
    const result = runCli(root, ["good.ts"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    // 内部接管 buildinfo：用户缓存原样保留，临时产物全部清理
    assert.equal(
      readFileSync(join(root, "user-cache.tsbuildinfo"), "utf8"),
      "SENTINEL_DO_NOT_TOUCH",
    );
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI 显式 --tsBuildInfoFile 时仍被末尾 override，用户缓存不被写入", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    writeFileSync(join(root, "user-cache.tsbuildinfo"), "SENTINEL_DO_NOT_TOUCH");
    const result = runCli(root, [
      "--incremental",
      "--tsBuildInfoFile",
      "user-cache.tsbuildinfo",
      "good.ts",
    ]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    // 末尾 override：用户文件未被写入，内部临时 buildinfo 已清理
    assert.equal(
      readFileSync(join(root, "user-cache.tsbuildinfo"), "utf8"),
      "SENTINEL_DO_NOT_TOUCH",
    );
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未启用 incremental 时显式 --tsBuildInfoFile 不产生文件、选项原样诊断", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    const result = runCli(root, ["--tsBuildInfoFile", "fresh.tsbuildinfo", "good.ts"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    // 无 incremental 时 tsc 忽略该选项：不创建文件，也不做内部 override
    assert.ok(!existsSync(join(root, "fresh.tsbuildinfo")));
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 带用户缓存 sentinel 与宽松副配置的 fixture：验证 project scope 与缓存保护 */
function createScopeFixture() {
  const root = createFixture({
    // 隐式 any：strict:true 报错，strict:false 通过——用于证明 project scope 生效
    "loose.ts": "function f(a) { return a; }\nexport default f;\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        incremental: true,
        tsBuildInfoFile: "user-cache.tsbuildinfo",
      },
    }),
    "other.json": JSON.stringify({ compilerOptions: { strict: false } }),
  });
  writeFileSync(join(root, "user-cache.tsbuildinfo"), "SENTINEL_DO_NOT_TOUCH");
  return root;
}

test("project 全变体生效于 scope：-P/--PROJECT 指向的 tsconfig 决定结果", () => {
  const root = createScopeFixture();
  try {
    // -P（单横线大写）→ other.json（strict:false）：隐式 any 不报错
    const loose = runCli(root, ["-P", "other.json", "loose.ts"]);
    assert.equal(loose.status, 0, loose.stderr + loose.stdout);
    // --PROJECT（双横线大写）→ tsconfig.json（strict:true）：隐式 any 报错
    const strict = runCli(root, ["--PROJECT", "tsconfig.json", "loose.ts"]);
    assert.notEqual(strict.status, 0);
    assert.match(stripAnsiCodes(strict.stdout + strict.stderr), /error TS7006/);
    // 两次运行都不允许写入用户缓存
    assert.equal(
      readFileSync(join(root, "user-cache.tsbuildinfo"), "utf8"),
      "SENTINEL_DO_NOT_TOUCH",
    );
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--types/--lib 与 --project 组合不绕过 wrapper，缓存 sentinel 不变", () => {
  const root = createScopeFixture();
  try {
    // list option 不消费 dash-token：--project 被 wrapper 消费，绝不能转发给 vue-tsc
    // 否则 vue-tsc 的 --project 会覆盖内部 -p，直接读写用户 tsconfig 的缓存路径
    for (const projectArgs of [
      ["--project", "tsconfig.json"],
      ["--p", "tsconfig.json"],
      ["-project", "tsconfig.json"],
      ["--project=tsconfig.json"],
    ]) {
      const types = runCli(root, ["--types", ...projectArgs, "loose.ts"]);
      assert.notEqual(types.status, 0);
      assert.match(stripAnsiCodes(types.stdout + types.stderr), /loose\.ts.*error TS7006/);
      assert.doesNotMatch(types.stdout + types.stderr, /TS2688|No files to check/);
    }
    assert.equal(
      readFileSync(join(root, "user-cache.tsbuildinfo"), "utf8"),
      "SENTINEL_DO_NOT_TOUCH",
    );
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);

    const lib = runCli(root, ["--lib", "--project", "tsconfig.json", "loose.ts"]);
    assert.notEqual(lib.status, 0);
    assert.equal(
      readFileSync(join(root, "user-cache.tsbuildinfo"), "utf8"),
      "SENTINEL_DO_NOT_TOUCH",
    );
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("配置 composite:true 且 incremental:false 时仍接管 buildinfo，诊断失败也清理干净", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    // incremental:false 不得屏蔽 composite 的 buildinfo 接管（tsc 会报 TS6379，但清理必须发生）
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { composite: true, incremental: false, strict: true } }),
    );
    const result = runCli(root, ["good.ts"]);
    assert.notEqual(result.status, 0);
    assert.match(stripAnsiCodes(result.stdout + result.stderr), /error TS6379/);
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --incremental false 不屏蔽配置 composite 的接管，诊断失败也清理干净", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "base.json": JSON.stringify({ compilerOptions: { composite: true, strict: true } }),
  });
  try {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
    const result = runCli(root, ["--incremental", "false", "good.ts"]);
    assert.notEqual(result.status, 0);
    assert.match(stripAnsiCodes(result.stdout + result.stderr), /error TS6379/);
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extends 链上游的 composite 自动接管 buildinfo 且检查成功", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "base.json": JSON.stringify({ compilerOptions: { composite: true, strict: true } }),
  });
  try {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
    const result = runCli(root, ["good.ts"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("检查失败时临时配置与内部 buildinfo 仍被清理", () => {
  const root = createFixture({
    "bad.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, incremental: true } }),
    );
    const result = runCli(root, ["bad.ts"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /error TS2322/);
    assert.deepEqual(readdirSyncTmpArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("使用 project references 时提示保留引用但不自动构建", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "other/tsconfig.json": JSON.stringify({
      compilerOptions: { composite: true, declaration: true, strict: true },
      files: [],
    }),
  });
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        // solution 式配置：files 为空 + references；18002（无输入）不应报错
        files: [],
        references: [{ path: "./other" }],
      }),
    );
    const result = runCli(root, ["good.ts"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /project references/);
    assert.match(result.stderr, /not built automatically/i);
    assert.match(result.stderr, /\.d\.ts outputs may be required/);
    // composite/declaration 不被移除，referenced 项目未被构建（无构建产物）
    assert.ok(!existsSync(join(root, "other", "tsconfig.tsbuildinfo")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--help 在歧义解算之前退出，不加载 TypeScript", () => {
  // 带歧义的 option+值 参数 + --help：help 必须在加载 TS 判定值归属之前生效
  const root = createFixture({ "block.cjs": BLOCK_TYPESCRIPT });
  try {
    const result = spawnSync(
      process.execPath,
      ["--require", join(root, "block.cjs"), CLI, "--outDir", "dist.ts", "--help"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stdout + result.stderr, /TYPESCRIPT_LOAD_BLOCKED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--changed 在仓库子目录运行时只收集该子目录的变更", () => {
  const root = createGitFixture({
    "sub/tsconfig.json": TSCONFIG,
    "sub/good.ts": "const a: number = 1;\nexport default a;\n",
    "other.ts": "const b: number = 1;\nexport default b;\n",
  });
  try {
    // 子目录外的 other.ts 改坏 + 子目录内新增坏文件
    writeFileSync(join(root, "other.ts"), 'const b: number = "x";\nexport default b;\n');
    writeFileSync(join(root, "sub", "bad.ts"), 'const c: number = "y";\nexport default c;\n');

    const result = runCli(join(root, "sub"), ["--changed"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /bad\.ts\(\d+,\d+\): error TS2322/);
    // 子目录外的变更不参与本次检查
    assert.doesNotMatch(result.stdout, /other\.ts\(\d+,\d+\): error/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--changed 收集工作区变更文件并检查", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    writeFileSync(join(root, "bad.ts"), 'const b: number = "x";\nexport default b;\n');
    const result = runCli(root, ["--changed"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /bad\.ts.*error TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--changed 无变更文件时提示并以 0 退出", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    const result = runCli(root, ["--changed"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No changed files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--changed 忽略未跟踪的 node_modules 内容", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    // 唯一变更位于未跟踪的 node_modules 内，视为无变更
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "pkg", "bad.ts"),
      'const b: number = "x";\nexport default b;\n',
    );
    const result = runCli(root, ["--changed"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No changed files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--changed 与 --errors-in-changed-only 组合忽略已提交依赖的历史错误", () => {
  const root = createGitFixture({
    "good.ts": 'import a from "./dep";\nexport default a;\n',
    "dep.ts": 'const a: number = "x";\nexport default a;\n',
  });
  try {
    // 修改 good.ts 使其成为变更文件；dep.ts 的历史错误已提交
    writeFileSync(join(root, "good.ts"), 'import a from "./dep";\nexport default String(a);\n');

    const lenient = runCli(root, ["--changed", "--errors-in-changed-only"]);
    assert.equal(lenient.status, 0, lenient.stderr);

    // 不加 --errors-in-changed-only 时 dep.ts 的历史错误仍然失败
    const strict = runCli(root, ["--changed"]);
    assert.notEqual(strict.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--staged 只检查已暂存文件", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    // 仅暂存的错误文件 + 仅工作区（未 git add）的错误修改
    writeFileSync(join(root, "staged-bad.ts"), 'const b: number = "x";\nexport default b;\n');
    git(root, ["add", "staged-bad.ts"]);
    writeFileSync(join(root, "good.ts"), 'const a: number = "y";\nexport default a;\n');

    const result = runCli(root, ["--staged"]);
    assert.notEqual(result.status, 0);
    // 暂存文件的错误被检查到；未暂存的 good.ts 不参与本次检查
    assert.match(result.stdout, /staged-bad\.ts.*error TS2322/);
    assert.doesNotMatch(result.stdout, /good\.ts\(\d+,\d+\): error/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--staged 无暂存文件时提示并以 0 退出", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    // 只有未暂存的工作区修改
    writeFileSync(join(root, "good.ts"), 'const a: number = "y";\nexport default a;\n');
    const result = runCli(root, ["--staged"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No staged files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--unstaged 只检查未暂存文件", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    // 仅暂存的错误文件 + 仅未暂存的错误修改
    writeFileSync(join(root, "staged-bad.ts"), 'const b: number = "x";\nexport default b;\n');
    git(root, ["add", "staged-bad.ts"]);
    writeFileSync(join(root, "good.ts"), 'const a: number = "y";\nexport default a;\n');

    const result = runCli(root, ["--unstaged"]);
    assert.notEqual(result.status, 0);
    // 未暂存的 good.ts 被检查到；staged-bad.ts 没有未暂存改动，不参与本次检查
    assert.match(result.stdout, /good\.ts\(\d+,\d+\): error TS2322/);
    assert.doesNotMatch(result.stdout, /staged-bad\.ts\(\d+,\d+\): error/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--unstaged 无未暂存文件时提示并以 0 退出", () => {
  const root = createGitFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
  });
  try {
    // 只有已暂存的修改
    writeFileSync(join(root, "good.ts"), 'const a: number = "y";\nexport default a;\n');
    git(root, ["add", "good.ts"]);
    const result = runCli(root, ["--unstaged"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No unstaged files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diff.relative=true 时子目录 --staged/--unstaged/--changed 只检查子目录的真实目标", () => {
  // git 在 diff.relative=true 时按 cwd 输出路径（"a.ts" 而非 "sub/a.ts"），
  // 按仓库根拼接会拿根目录同名文件顶替：sub 的错误被漏掉、根文件的错误被误检。
  // 两个文件用不同的错误类型，从诊断消息即可分辨被检查的到底是哪一个。
  const root = createGitFixture({
    "sub/tsconfig.json": TSCONFIG,
    "sub/a.ts": "const subValue: number = 1;\nexport default subValue;\n",
    "a.ts": "const rootValue: Date = new Date();\nexport default rootValue;\n",
  });
  const sub = join(root, "sub");
  const subError = 'const subValue: number = "sub";\nexport default subValue;\n';
  const rootError = 'const rootValue: Date = "root";\nexport default rootValue;\n';
  // 子目录里被检查到的必须是 sub/a.ts：路径形如 "a.ts(...)"，而不是根目录的 "../a.ts(...)"
  const assertSubTarget = (flag: string, result: ReturnType<typeof runCli>) => {
    assert.equal(result.status, 2, `${flag}: ${result.stdout}${result.stderr}`);
    assert.match(
      result.stdout,
      /a\.ts\(\d+,\d+\): error TS2322: Type 'string' is not assignable to type 'number'\./,
      `${flag} 未检查到 sub/a.ts：${result.stdout}`,
    );
    assert.doesNotMatch(
      result.stdout,
      /\.\.\//,
      `${flag} 误检了仓库根目录的同名文件：${result.stdout}`,
    );
  };
  try {
    git(root, ["config", "diff.relative", "true"]);
    // 根目录同名文件也改坏：它不在 sub 的 pathspec 内，绝不能被算作本次目标
    writeFileSync(join(root, "a.ts"), rootError);

    writeFileSync(join(sub, "a.ts"), subError);
    assertSubTarget("--changed", runCli(sub, ["--changed"]));

    git(root, ["add", "sub/a.ts"]);
    assertSubTarget("--staged", runCli(sub, ["--staged"]));

    writeFileSync(join(sub, "a.ts"), subError.replace('"sub"', '"worktree"'));
    assertSubTarget("--unstaged", runCli(sub, ["--unstaged"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("仓库根目录名带尾随空格时 --changed/--staged/--unstaged 仍能收集变更", () => {
  // git rev-parse 原样返回带尾随空格的仓库根，CLI 不能把它 trim 掉
  const parent = mkdtempSync(join(tmpdir(), "vtf-space-"));
  const root = createGitFixture(
    {
      "sub/tsconfig.json": TSCONFIG,
      "sub/good.ts": "export default 1;\n",
    },
    join(parent, "repo "),
  );
  const sub = join(root, "sub");
  try {
    const errorContent = 'const g: number = "bad";\nexport default g;\n';

    writeFileSync(join(sub, "good.ts"), errorContent);
    const unstaged = runCli(sub, ["--unstaged"]);
    assert.equal(unstaged.status, 2, unstaged.stdout + unstaged.stderr);
    assert.match(unstaged.stdout, /good\.ts\(\d+,\d+\): error TS2322/);

    git(root, ["add", "sub/good.ts"]);
    const staged = runCli(root, ["--staged"]);
    assert.equal(staged.status, 2, staged.stdout + staged.stderr);
    assert.match(staged.stdout, /sub\/good\.ts\(\d+,\d+\): error TS2322/);

    writeFileSync(join(sub, "new.ts"), errorContent);
    const changed = runCli(root, ["--changed"]);
    assert.equal(changed.status, 2, changed.stdout + changed.stderr);
    assert.match(changed.stdout, /sub\/new\.ts\(\d+,\d+\): error TS2322/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("优先使用 cwd 项目里的 vue-tsc 而非 bundle 旁的副本", () => {
  const root = createFixture({
    "good.ts": "const a: number = 1;\nexport default a;\n",
    "node_modules/vue-tsc/package.json": JSON.stringify({
      name: "vue-tsc",
      version: "0.0.0-stub",
      bin: { "vue-tsc": "./bin/vue-tsc.js" },
    }),
    "node_modules/vue-tsc/bin/vue-tsc.js": 'console.log("STUB_VUE_TSC_INVOKED");\n',
  });
  try {
    const result = runCli(root, ["good.ts"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STUB_VUE_TSC_INVOKED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stubVueTsc(script: string) {
  return {
    "node_modules/vue-tsc/package.json": JSON.stringify({
      name: "vue-tsc",
      version: "0.0.0-stub",
      bin: { "vue-tsc": "./bin/vue-tsc.js" },
    }),
    "node_modules/vue-tsc/bin/vue-tsc.js": script,
  };
}

// 从实际 CLI 生成的临时配置输出文件顺序，不依赖 TS 诊断的排序规则。
const PRINT_CONFIG_FILES = `
const { readFileSync } = require("fs");
const { relative } = require("path");
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf("-p") + 1], "utf8"));
console.log(JSON.stringify(config.files.map(file => relative(process.cwd(), file))));
`;

test("显式文件与 --changed 取并集，显式优先且重复项不改变顺序", () => {
  const root = createGitFixture({
    "z-explicit.ts": "export default 1;\n",
    "b-shared.ts": "export default 1;\n",
    ...stubVueTsc(PRINT_CONFIG_FILES),
  });
  try {
    writeFileSync(join(root, "b-shared.ts"), "export default 2;\n");
    writeFileSync(join(root, "a-new.ts"), "export default 3;\n");
    for (const flags of [["--changed"], ["--unstaged", "--staged", "--changed"]]) {
      const result = runCli(root, ["z-explicit.ts", ...flags, "b-shared.ts", "z-explicit.ts"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["z-explicit.ts", "b-shared.ts", "a-new.ts"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--staged --unstaged 按收集器顺序合并去重，不含未跟踪文件", () => {
  const root = createGitFixture({
    "a-unstaged.ts": "export default 1;\n",
    "b-shared.ts": "export default 1;\n",
    "z-staged.ts": "export default 1;\n",
    ...stubVueTsc(PRINT_CONFIG_FILES),
  });
  try {
    writeFileSync(join(root, "b-shared.ts"), "export default 2;\n");
    writeFileSync(join(root, "z-staged.ts"), "export default 2;\n");
    git(root, ["add", "b-shared.ts", "z-staged.ts"]);
    writeFileSync(join(root, "b-shared.ts"), "export default 3;\n");
    writeFileSync(join(root, "a-unstaged.ts"), "export default 2;\n");
    writeFileSync(join(root, "untracked.ts"), "export default 1;\n");
    for (const flags of [
      ["--staged", "--unstaged"],
      ["--unstaged", "--staged"],
    ]) {
      const result = runCli(root, flags);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["b-shared.ts", "z-staged.ts", "a-unstaged.ts"]);
    }
    const all = runCli(root, ["--unstaged", "--staged", "--changed"]);
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(JSON.parse(all.stdout), [
      "a-unstaged.ts",
      "b-shared.ts",
      "z-staged.ts",
      "untracked.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, diagnostic, status] of [
  ["全局诊断", "error TS5083: Cannot read file 'missing.json'.", 2],
  ["无诊断崩溃", "Error: vue-tsc crashed", 7],
] as const) {
  test(`--errors-in-changed-only 保留 stub ${name}的输出及非零退出码`, () => {
    const root = createFixture({
      "good.ts": "export default 1;\n",
      ...stubVueTsc(
        `console.log("STUB_STDOUT"); console.error(${JSON.stringify(diagnostic)}); process.exitCode = ${status};`,
      ),
    });
    try {
      const result = runCli(root, ["--errors-in-changed-only", "good.ts"]);
      assert.equal(result.status, status);
      assert.equal(result.stdout, "STUB_STDOUT\n");
      assert.equal(result.stderr, `${diagnostic}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const BLOCK_TYPESCRIPT = `
const Module = require("module");
const load = Module._load;
Module._load = function(request, ...args) {
  if (request === "typescript") {
    console.error("TYPESCRIPT_LOAD_BLOCKED");
    throw new Error("blocked typescript for regression test");
  }
  return load.call(this, request, ...args);
};
`;

for (const flag of ["-h", "--help", "--changed", "--staged", "--unstaged"]) {
  test(`${flag} 早退出不请求 TypeScript（包括 bundle 回退）`, () => {
    const root = createGitFixture({ "block.cjs": BLOCK_TYPESCRIPT });
    try {
      const result = spawnSync(
        process.execPath,
        ["--require", join(root, "block.cjs"), CLI, flag],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /TYPESCRIPT_LOAD_BLOCKED/);
      assert.match(
        result.stdout,
        flag.endsWith("h") || flag === "--help" ? /Usage:/ : /No .* files/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("无参数不加载 TypeScript；有目标缺少 TypeScript 仍以 1 退出", () => {
  const root = createFixture({ "block.cjs": BLOCK_TYPESCRIPT, "good.ts": "export default 1;" });
  try {
    for (const args of [[], ["good.ts"]]) {
      const result = spawnSync(
        process.execPath,
        ["--require", join(root, "block.cjs"), CLI, ...args],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr);
      if (args.length === 0) {
        assert.doesNotMatch(result.stderr, /TYPESCRIPT_LOAD_BLOCKED/);
        assert.match(result.stderr, /No files to check/);
      } else {
        assert.equal(result.stderr.match(/TYPESCRIPT_LOAD_BLOCKED/g)?.length, 2);
        assert.match(result.stderr, /Cannot find typescript/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("重复创建有效配置仅成功加载一次 cwd TypeScript", () => {
  const root = realpathSync(createFixture({ "good.ts": "export default 1;" }));
  const utilUrl = new URL("../src/util.ts", import.meta.url).href;
  try {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(
      realpathSync(join(dirname(CLI), "node_modules", "typescript")),
      join(root, "node_modules", "typescript"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(
      join(root, "count.cjs"),
      `const Module = require("module");
const load = Module._load;
Module._load = function(request, ...args) {
  if (request === "typescript") console.error("TYPESCRIPT_LOAD_COUNT");
  return load.call(this, request, ...args);
};`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        join(root, "count.cjs"),
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAndSetupTsConfig } from ${JSON.stringify(utilUrl)};
const read = () => JSON.parse(readFileSync(createAndSetupTsConfig(["good.ts"]), "utf8"));
const first = read();
assert.deepEqual(read(), first);
assert.deepEqual(first.files, [${JSON.stringify(join(root, "good.ts"))}]);
assert.equal(first.compilerOptions.strict, true);
assert.equal(first.compilerOptions.skipLibCheck, true);`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr.match(/TYPESCRIPT_LOAD_COUNT/g)?.length, 1);
    assert.deepEqual(readdirSyncTmpConfigs(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readdirSyncTmpConfigs(root: string) {
  return readdirSync(root).filter((f: string) => /^tsconfig\..+\.json$/.test(f));
}

/** 临时 tsconfig 与本次运行独占 buildinfo 都不允许残留 */
function readdirSyncTmpArtifacts(root: string) {
  return readdirSync(root).filter((f: string) => /^tsconfig\..+\.(json|tsbuildinfo)$/.test(f));
}

/** 包内随产物一起分发的 skill 源文件；CLI = <repo>/vue-tsc-files，故 dirname 即包根 */
const BUNDLED_SKILL = join(dirname(CLI), ".agents", "skills", "vue-tsc-files", "SKILL.md");

/** 建不了符号链接的平台（Windows 缺特权）让对应用例直接跳过，别变成 CI 随机失败 */
function canCreateSymlink(root: string, target: string, type?: "dir") {
  const probe = join(root, "probe-link");
  try {
    symlinkSync(target, probe, type);
  } catch {
    return false;
  }
  rmSync(probe, { force: true });
  return true;
}

/** skill 安装目录里不该留下暂存目录/临时文件 */
function hasInstallArtifact(dir: string) {
  return readdirSync(dir).some((name) => name.startsWith(".vue-tsc-files"));
}

test("install --skill 装到当前项目 .agents/skills/，重跑识别为最新", () => {
  const root = createFixture({ "good.ts": "export default 1;\n" });
  try {
    const target = join(root, ".agents", "skills", "vue-tsc-files", "SKILL.md");

    const installed = runCli(root, ["install", "--skill"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Installed skill to /);
    assert.equal(readFileSync(target, "utf8"), readFileSync(BUNDLED_SKILL, "utf8"));

    const again = runCli(root, ["install", "--skill"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already up to date/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install --skill 遇到本地改过的 skill 报冲突，--force 覆盖", () => {
  const root = createFixture({ "good.ts": "export default 1;\n" });
  try {
    const target = join(root, ".agents", "skills", "vue-tsc-files", "SKILL.md");
    assert.equal(runCli(root, ["install", "--skill"]).status, 0);
    writeFileSync(target, "locally edited\n");

    const conflict = runCli(root, ["install", "--skill"]);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /--force/);
    assert.equal(readFileSync(target, "utf8"), "locally edited\n");

    assert.equal(runCli(root, ["install", "--skill", "--force"]).status, 0);
    assert.equal(readFileSync(target, "utf8"), readFileSync(BUNDLED_SKILL, "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install --skill --user 装到用户主目录 .agents/skills/", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-user-"));
  const home = mkdtempSync(join(tmpdir(), "vtf-skill-home-"));
  try {
    const result = spawnSync(process.execPath, [CLI, "install", "--skill", "--user"], {
      cwd: root,
      encoding: "utf8",
      // os.homedir() 在 POSIX 读 $HOME、Windows 读 %USERPROFILE%，两个都指向临时目录
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      existsSync(join(home, ".agents", "skills", "vue-tsc-files", "SKILL.md")),
      "skill 未落到用户主目录",
    );
    assert.equal(existsSync(join(root, ".agents")), false);
    assert.equal(
      readFileSync(join(home, ".agents", "skills", "vue-tsc-files", "SKILL.md"), "utf8"),
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("install --skill 无需 tsconfig 与 TypeScript", () => {
  // 故意建在无 tsconfig.json 的目录，并屏蔽 typescript 加载
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-nocfg-"));
  try {
    writeFileSync(join(root, "block.cjs"), BLOCK_TYPESCRIPT);
    const result = spawnSync(
      process.execPath,
      ["--require", join(root, "block.cjs"), CLI, "install", "--skill"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /TYPESCRIPT_LOAD_BLOCKED/);
    assert.ok(existsSync(join(root, ".agents", "skills", "vue-tsc-files", "SKILL.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install 裸跑与 install --help 的用法输出", () => {
  const root = createFixture({ "good.ts": "export default 1;\n" });
  try {
    const bare = runCli(root, ["install"]);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /requires --skill/);

    const help = runCli(root, ["install", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /vue-tsc-files install --skill/);

    // 打错的参数名最需要合法选项列表，未知参数同样要附用法
    const unknown = runCli(root, ["install", "--skil"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown option for install: --skil/);
    assert.match(unknown.stderr, /--force/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install --skill 目标被普通文件占用时不覆盖，报错退出 1", () => {
  const root = createFixture({ "good.ts": "export default 1;\n" });
  try {
    const target = join(root, ".agents", "skills", "vue-tsc-files");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "user source file\n");

    for (const args of [
      ["install", "--skill"],
      ["install", "--skill", "--force"],
    ]) {
      const result = runCli(root, args);
      assert.equal(result.status, 1, `${args.join(" ")} 不应成功`);
      assert.match(result.stderr, /not a directory/);
    }
    assert.equal(readFileSync(target, "utf8"), "user source file\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install --skill 目标目录与内部 SKILL.md 都是 symlink 时 --force 只换内容不拆链接", () => {
  const root = createFixture({ "good.ts": "export default 1;\n" });
  try {
    const realDir = join(root, "real-skill");
    const target = join(root, ".agents", "skills", "vue-tsc-files");
    const elsewhere = join(root, "elsewhere.md");
    mkdirSync(realDir);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(elsewhere, "user's own file\n");
    if (!canCreateSymlink(root, realDir, "dir")) return;
    symlinkSync(realDir, target, "dir");
    symlinkSync(elsewhere, join(realDir, "SKILL.md"));

    const conflict = runCli(root, ["install", "--skill"]);
    assert.equal(conflict.status, 1, conflict.stdout + conflict.stderr);
    assert.match(conflict.stderr, /--force/);

    const forced = runCli(root, ["install", "--skill", "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /Installed skill to/);
    // 两层链接都留着，被替换的只有 SKILL.md 这一个目录项
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(lstatSync(join(realDir, "SKILL.md")).isSymbolicLink(), false);
    assert.equal(
      readFileSync(join(realDir, "SKILL.md"), "utf8"),
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
    assert.equal(readFileSync(elsewhere, "utf8"), "user's own file\n");
    assert.equal(hasInstallArtifact(realDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install --skill 覆盖 hardlink 时外部文件不变，新装文件不共享 inode", () => {
  const root = createFixture({ "good.ts": "export default 1;\n" });
  try {
    const target = join(root, ".agents", "skills", "vue-tsc-files");
    const elsewhere = join(root, "elsewhere.md");
    writeFileSync(elsewhere, "shared inode\n");
    mkdirSync(target, { recursive: true });
    linkSync(elsewhere, join(target, "SKILL.md"));

    assert.equal(runCli(root, ["install", "--skill"]).status, 1);
    const forced = runCli(root, ["install", "--skill", "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    // 原地写会把 skill 内容写进外部文件；换目录项后外部文件与 inode 都不受影响
    assert.equal(readFileSync(elsewhere, "utf8"), "shared inode\n");
    assert.equal(
      readFileSync(join(target, "SKILL.md"), "utf8"),
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
    assert.notEqual(statSync(join(target, "SKILL.md")).ino, statSync(elsewhere).ino);
    assert.equal(hasInstallArtifact(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install --skill 目标 SKILL.md 是目录时报错退出 1，原样保留用户内容", () => {
  const root = createFixture({ "good.ts": "export default 1;\n" });
  try {
    const target = join(root, ".agents", "skills", "vue-tsc-files", "SKILL.md");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.md"), "user's own file\n");

    // 随包 payload 只有 SKILL.md，这一条走的就是"payload 文件撞上目标目录"的预检
    const result = runCli(root, ["install", "--skill", "--force"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /is a directory/);
    assert.equal(readFileSync(join(target, "keep.md"), "utf8"), "user's own file\n");
    assert.equal(hasInstallArtifact(join(root, ".agents", "skills", "vue-tsc-files")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
