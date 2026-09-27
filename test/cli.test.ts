import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "vue-tsc-files");

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true },
});

/** 创建独立的临时 fixture 项目（tsconfig + 源文件），避免污染真实仓库 */
function createFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "vtf-it-"));
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
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
function createGitFixture(files: Record<string, string>) {
  const root = createFixture(files);
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "init"]);
  return root;
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

function readdirSyncTmpConfigs(root: string) {
  return readdirSync(root).filter((f: string) => /^tsconfig\..+\.json$/.test(f));
}
