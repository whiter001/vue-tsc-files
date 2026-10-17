import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { createRequire } from "module";
import {
  buildArgs,
  checkCanaryResult,
  countDiagnosticLines,
  createFixture,
  fullCommand,
  modesFor,
  removeFixture,
  runNegativeCanary,
  runOnce,
  validate,
  type Mode,
  type RunResult,
} from "../bench/harness.ts";
import { SCENARIOS, type Scenario } from "../bench/scenarios.ts";

const require = createRequire(import.meta.url);

function scenario(name: string): Scenario {
  const found = SCENARIOS.find((item) => item.name === name);
  assert.ok(found, `缺少场景 ${name}`);
  return found;
}

/** harness 在 tmp 里留下的 fixture 前缀 */
const FIXTURE_PREFIX = "vtf-bench-";

function fixtureDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(FIXTURE_PREFIX));
}

/**
 * 跑一段动作，并断言 tmp 里没有多出 fixture 目录。
 * canary 出错时最容易被忽略的正是"半个 fixture 留在盘上"。
 */
function withoutFixtureLeak(run: () => void): void {
  const before = new Set(fixtureDirs());
  try {
    run();
  } finally {
    const leaked = fixtureDirs().filter((name) => !before.has(name));
    assert.deepEqual(leaked, [], `临时目录残留：${leaked.join(", ")}`);
  }
}

/** 用真实编译器跑一轮并按场景契约校验，返回结果与失败原因 */
function runScenarioCell(
  target: Scenario,
  mode: Mode,
  env?: NodeJS.ProcessEnv,
): { result: RunResult; failure: string | undefined } {
  const root = createFixture(target);
  try {
    const result = runOnce(fullCommand(mode, buildArgs(mode, root, target, "cold")), root, {
      ...process.env,
      ...env,
    });
    return { result, failure: validate(target, mode, "cold", root, result)?.reason };
  } finally {
    removeFixture(root);
  }
}

test("vue fixture 的 node_modules/vue 指向仓库里真实安装的 vue", () => {
  const root = createFixture(scenario("vue-sfc"));
  try {
    const link = `${root}/node_modules/vue`;
    assert.ok(existsSync(`${link}/package.json`), "fixture 里没有可用的 vue 包");
    const installed = createRequire(`${link}/probe.ts`);
    assert.equal(installed("vue/package.json").version, require("vue/package.json").version);
    assert.equal(
      realpathSync(link),
      realpathSync(require.resolve("vue/package.json").replace(/package\.json$/, "")),
    );
  } finally {
    removeFixture(root);
  }
});

test("正确模板三种模式都通过，不产生任何诊断", () => {
  const target = scenario("vue-sfc");
  for (const mode of modesFor(target)) {
    const { result, failure } = runScenarioCell(target, mode);
    assert.equal(failure, undefined, `${mode}: ${failure ?? ""}`);
    assert.equal(result.exit, 0);
  }
});

test("模板引用不存在的属性时，负向预检在三种模式下都报出 TS2339", () => {
  let outcome: ReturnType<typeof runNegativeCanary> | undefined;
  withoutFixtureLeak(() => {
    outcome = runNegativeCanary(scenario("vue-sfc"));
  });
  assert.deepEqual(
    outcome?.failures.map((failure) => failure.reason),
    [],
  );
  assert.equal(outcome?.passed, true);
});

test("fixture 缺少 vue 时负向预检必须失败，否则等于没检查模板", () => {
  const target: Scenario = { ...scenario("vue-sfc"), requiresVue: false };
  let outcome: ReturnType<typeof runNegativeCanary> | undefined;
  withoutFixtureLeak(() => {
    outcome = runNegativeCanary(target, ["direct"]);
  });
  assert.equal(outcome?.passed, false);
  assert.match(outcome?.failures[0]!.reason, /退出码/);
});

test("canary 指向不存在的文件时按失败算，且不留残目录", () => {
  const base = scenario("vue-sfc");
  const target: Scenario = {
    ...base,
    name: "canary-missing-file",
    negativeCanary: { ...base.negativeCanary!, file: "src/NotThere.vue" },
  };
  let outcome: ReturnType<typeof runNegativeCanary> | undefined;
  withoutFixtureLeak(() => {
    outcome = runNegativeCanary(target, ["direct"]);
  });
  assert.equal(outcome?.passed, false);
  assert.match(outcome?.failures[0]!.reason, /src[\\/]NotThere\.vue/);
});

test("canary 片段对不上时按失败算，且不留残目录", () => {
  const base = scenario("vue-sfc");
  const target: Scenario = {
    ...base,
    name: "canary-no-search",
    negativeCanary: { ...base.negativeCanary!, search: "{{ 这段模板里根本没有 }}" },
  };
  let outcome: ReturnType<typeof runNegativeCanary> | undefined;
  withoutFixtureLeak(() => {
    outcome = runNegativeCanary(target, ["direct"]);
  });
  assert.equal(outcome?.passed, false);
  assert.match(outcome?.failures[0]!.reason, /canary 片段/);
});

test("fixture 创建到一半失败时抛出原错，canary 转成结构化失败，两者都不留残目录", () => {
  const base = scenario("vue-sfc");
  // 路径里的 NUL 字节让写文件必然抛错，等价于场景配置坏了
  const target: Scenario = {
    ...base,
    name: "canary-broken-setup",
    files: { ...base.files, "src/bro\u0000ken.ts": "export const x = 1;\n" },
  };
  withoutFixtureLeak(() => {
    assert.throws(() => createFixture(target));
  });
  let outcome: ReturnType<typeof runNegativeCanary> | undefined;
  withoutFixtureLeak(() => {
    outcome = runNegativeCanary(target, ["direct"]);
  });
  assert.equal(outcome?.passed, false);
  assert.match(outcome?.failures[0]!.reason, /fixture 创建失败/);
});

test("canary 判定拒绝明显不符合预期的结果", () => {
  const canary = scenario("vue-sfc").negativeCanary!;
  const fake = (exit: number, stdout: string): RunResult => ({
    wallMs: 0,
    exit,
    stdout,
    stderr: "",
  });
  const bad: RunResult[] = [
    fake(0, ""),
    fake(2, ""),
    fake(2, "src/Comp0.vue(5,28): error TS2551: Property 'value' does not exist.\n"),
    fake(2, "src/seed.ts(1,1): error TS2339: nope\n"),
    fake(2, "src/Comp0.vue(5,28): error TS2339: a\nsrc/Comp1.vue(5,28): error TS2339: b\n"),
  ];
  for (const result of bad) {
    assert.notEqual(
      checkCanaryResult(canary, "direct", result),
      undefined,
      `本该被拒绝：${result.stdout}`,
    );
  }
  assert.equal(
    checkCanaryResult(canary, "direct", {
      wallMs: 0,
      exit: 2,
      stdout: "src/Comp0.vue(5,28): error TS2339: Property 'vtfCanaryMissing' does not exist.\n",
      stderr: "",
    }),
    undefined,
  );
});

test("三种模式的 argv 都带 --pretty false", () => {
  for (const name of ["vue-sfc", "git-no-target"]) {
    const target = scenario(name);
    const root = createFixture(target);
    try {
      for (const mode of modesFor(target)) {
        const args = buildArgs(mode, root, target, "cold");
        assert.ok(
          args.includes("--pretty") && args[args.indexOf("--pretty") + 1] === "false",
          `${name}/${mode} 缺 --pretty false：${args.join(" ")}`,
        );
      }
    } finally {
      removeFixture(root);
    }
  }
});

test("FORCE_COLOR 下 large-diagnostics 仍按 30 条诊断计数", () => {
  const target = scenario("large-diagnostics");
  const { result, failure } = runScenarioCell(target, "wrapper", {
    FORCE_COLOR: "1",
    NO_COLOR: "",
  });
  assert.equal(failure, undefined, failure ?? "");
  assert.equal(result.exit, 2);
  assert.equal(countDiagnosticLines(result.stdout) + countDiagnosticLines(result.stderr), 30);
  assert.equal(result.stdout.includes("\u001b["), false, "输出里仍有 ANSI 转义，诊断行计数不可信");
});

test("诊断行计数只认 error TSxxxx: 形式的行", () => {
  assert.equal(countDiagnosticLines("src/a.ts(1,1): error TS2322: bad\n"), 1);
  assert.equal(countDiagnosticLines(""), 0);
  // tsc 开 pretty 又带颜色时，error 与 TSxxxx 之间被 ANSI 隔开，这行就数不到——
  // 这正是每条模式都必须显式 --pretty false 的原因
  assert.equal(
    countDiagnosticLines(
      "\u001b[96msrc/a.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m14\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string'.\n",
    ),
    0,
  );
});
