import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "fs";
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

function readdirSyncTmpConfigs(root: string) {
  return readdirSync(root).filter((f: string) => /^tsconfig\..+\.json$/.test(f));
}
