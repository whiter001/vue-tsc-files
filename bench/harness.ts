import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { NegativeCanary, Scenario } from "./scenarios.ts";

const require = createRequire(import.meta.url);
const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BENCH_DIR, "..");

/** 被测的构建产物 */
export const CLI_PATH = join(REPO_ROOT, "vue-tsc-files");

/** 直接调用的 vue-tsc 入口，与 wrapper 最终 spawn 的是同一个文件 */
export const VUE_TSC_ENTRY = join(
  dirname(require.resolve("vue-tsc/package.json")),
  "bin",
  "vue-tsc.js",
);

/** 真实 vue 包的目录，fixture 的 node_modules/vue 链到这里，依赖才找得到 @vue/* */
export const VUE_PACKAGE_DIR = dirname(require.resolve("vue/package.json"));

/** 内存探针，以 --require 预加载进被测进程 */
const RSS_PROBE = join(BENCH_DIR, "probe.cjs");

/** 只做参数解析与临时配置生成、不启动 vue-tsc 的子进程脚本 */
const PREP_SCRIPT = join(BENCH_DIR, "prep.ts");

export type CacheMode = "cold" | "warm" | "incremental";
export type Mode = "direct" | "wrapper" | "wrapper-filter";

/** 该场景要跑哪些模式。Git 无目标这类场景没有 direct 对照方。 */
export function modesFor(scenario: Scenario): Mode[] {
  return scenario.comparable === false ? ["wrapper"] : ["direct", "wrapper", "wrapper-filter"];
}

/**
 * direct 直接跑 vue-tsc 入口，wrapper 模式才走 CLI。
 * 计时、灌热、诊断、内存四条路径都必须经过这里——曾经灌热那一轮漏了分支，
 * 把 vue-tsc 的参数喂给了 CLI，校验立刻抓出来。
 */
export function fullCommand(mode: Mode, args: string[]): string[] {
  return mode === "direct" ? args : [CLI_PATH, ...args];
}

export interface RunResult {
  wallMs: number;
  exit: number;
  stdout: string;
  stderr: string;
}

/** 把 fixture 写到临时目录。git 场景顺带建仓库，否则 --staged 无从谈起。 */
export function createFixture(scenario: Scenario): string {
  const root = mkdtempSync(join(tmpdir(), `vtf-bench-${scenario.name}-`));
  try {
    for (const [relative, content] of Object.entries(scenario.files)) {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(scenario.tsconfig, null, 2));
    if (scenario.requiresVue) linkVue(root);
    if (scenario.git) {
      const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.name=bench", "-c", "user.email=bench@bench", "commit", "-qm", "base");
    }
  } catch (error) {
    // 半拉子 fixture 留在 tmp 里没人认领，同样是污染；rm 失败就让这个错误顶上来
    removeFixture(root);
    throw error;
  }
  return root;
}

/**
 * 临时目录里没有 vue，模板里的类型错误会被静默吞掉（实测退出码仍是 0）。
 * Windows 上普通符号链接要额外权限，用 junction。
 */
function linkVue(root: string): void {
  const modules = join(root, "node_modules");
  mkdirSync(modules, { recursive: true });
  symlinkSync(
    VUE_PACKAGE_DIR,
    join(modules, "vue"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

export function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/**
 * direct 模式的 control 配置：编译选项来自与 wrapper 完全相同的场景配置，
 * 只把 files 钉成同一批目标、include 清空，保证它不会多查任何一个文件。
 */
function writeControlConfig(root: string, scenario: Scenario): string {
  const path = join(root, "control.tsconfig.json");
  writeFileSync(
    path,
    JSON.stringify(
      { ...(scenario.tsconfig as object), files: scenario.targets, include: [] },
      null,
      2,
    ),
  );
  return path;
}

export interface ArgOptions {
  /** 单独一轮要编译器自报分阶段耗时；主计时轮不带，避免输出污染 wall-clock */
  extendedDiagnostics?: boolean;
}

/** 三种模式都要显式带上：开了 pretty 的彩色诊断行数不出现在 error TSxxxx: 处，计数会静默变 0 */
const PRETTY = ["--pretty", "false"];

/** 构造某场景某模式的 argv */
export function buildArgs(
  mode: Mode,
  root: string,
  scenario: Scenario,
  cacheMode: CacheMode,
  options: ArgOptions = {},
): string[] {
  const incremental =
    cacheMode === "incremental" ? ["--incremental", "--tsBuildInfoFile", "bench.tsbuildinfo"] : [];
  const diagnostics = options.extendedDiagnostics ? ["--extendedDiagnostics"] : [];

  if (mode === "direct") {
    const control = writeControlConfig(root, scenario);
    return [VUE_TSC_ENTRY, "-p", control, "--noEmit", ...incremental, ...diagnostics, ...PRETTY];
  }

  // 场景自带 wrapperArgs（如 --staged）时，目标文件与过滤器都不适用
  if (scenario.wrapperArgs) return [...scenario.wrapperArgs, ...PRETTY];

  const filter = mode === "wrapper-filter" ? ["--errors-in-changed-only"] : [];
  // 目标文件排在转发 flag 之前，与 README 用法一致
  return [...scenario.targets, ...filter, ...incremental, ...diagnostics, ...PRETTY];
}

/** 运行一次并计时。wall-clock 含进程启动与退出，正是用户感知的那一段 */
export function runOnce(command: string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  const started = performance.now();
  const result = spawnSync(process.execPath, command, { cwd, encoding: "utf8", env });
  return {
    wallMs: performance.now() - started,
    exit: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** 诊断行计数：tsc/vue-tsc 的错误都以 error TSxxxx: 开头 */
export function countDiagnosticLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line)).length;
}

export interface ValidationFailure {
  cell: string;
  reason: string;
}

function trimOutput(result: RunResult): string {
  const text = `${result.stdout}${result.stderr}`.trim();
  const first = text.split(/\r?\n/).slice(0, 6).join("\n");
  return first.length > 0 ? `--- 输出片段 ---\n${first}` : "--- 无任何输出 ---";
}

/**
 * 计时前必须先过这一关。没有它，一次因为 fixture 写坏而"跑得很快"的运行
 * 会被当成漂亮的基准点，这正是 #23 要防的测量误判。
 *
 * afterWarmCache 表示增量缓存已经建立：direct 此时退出码会变，wrapper 不会。
 */
export function validate(
  scenario: Scenario,
  mode: Mode,
  cacheMode: CacheMode,
  root: string,
  result: RunResult,
  afterWarmCache = false,
): ValidationFailure | undefined {
  const cell = `${scenario.name} / ${mode} / ${cacheMode}`;
  const fail = (reason: string): ValidationFailure => ({ cell, reason });

  const expectedExit =
    afterWarmCache && mode === "direct" && scenario.expect.directExitAfterWarmCache !== undefined
      ? scenario.expect.directExitAfterWarmCache
      : scenario.expect.exit;
  if (result.exit !== expectedExit) {
    return fail(`退出码 ${result.exit}，期望 ${expectedExit}\n${trimOutput(result)}`);
  }
  for (const pattern of scenario.expect.stdout ?? []) {
    if (!pattern.test(result.stdout)) {
      return fail(`stdout 未匹配 ${pattern}\n${trimOutput(result)}`);
    }
  }
  for (const pattern of scenario.expect.stderr ?? []) {
    if (!pattern.test(result.stderr)) {
      return fail(`stderr 未匹配 ${pattern}\n${trimOutput(result)}`);
    }
  }
  const expected = scenario.expect.diagnosticLines;
  if (expected !== undefined) {
    const actual = countDiagnosticLines(result.stdout) + countDiagnosticLines(result.stderr);
    if (actual !== expected) {
      return fail(
        `诊断行 ${actual}，期望 ${expected}（多半是检查没真正跑起来）\n${trimOutput(result)}`,
      );
    }
  }
  // 反复跑基准不能污染工作目录，否则清理成本会从测量里消失
  const leaked = readdirSync(root).filter((name) =>
    /^tsconfig\..+\.(json|tsbuildinfo)$/.test(name),
  );
  if (leaked.length > 0) {
    return fail(`fixture 目录残留临时产物：${leaked.join(", ")}`);
  }
  return undefined;
}

export interface CanaryFailure {
  mode: Mode;
  reason: string;
}

export interface CanaryOutcome {
  passed: boolean;
  failures: CanaryFailure[];
}

/**
 * 纯判定，不碰进程也不计时，可以直接喂伪 RunResult 做单测。
 * 精确到诊断码与落点文件：整个检查崩掉时的输出照样带 error，"有错误"不算通过。
 */
export function checkCanaryResult(
  canary: NegativeCanary,
  mode: Mode,
  result: RunResult,
): string | undefined {
  const text = `${result.stdout}${result.stderr}`;
  const lines = text.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line));
  const cell = `negative-canary / ${mode}`;
  if (result.exit !== 2) {
    return `[${cell}] 坏模板应让检查失败，退出码却是 ${result.exit}（多半是模板根本没被检查）\n${trimOutput(result)}`;
  }
  if (lines.length !== 1) {
    return `[${cell}] 诊断 ${lines.length} 条，期望恰好 1 条\n${trimOutput(result)}`;
  }
  const line = lines[0] ?? "";
  if (!/error TS2339:/.test(line)) {
    return `[${cell}] 诊断码不是 TS2339：${line.trim()}`;
  }
  if (!line.includes(canary.diagnosticFile)) {
    return `[${cell}] 诊断不在 ${canary.diagnosticFile} 上：${line.trim()}`;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 负向预检：计时之前用一个"必然出错"的模板把每个模式真跑一遍。
 * 失败即说明这个场景没在做类型检查，它的时间数字没有意义，整场景得跳过。
 * 用独立的 fixture 目录，跑完直接删，因此既不碰缓存也不进计时数据。
 * 配置写错（canary 指向不存在的文件、片段对不上）同样按失败算，
 * 但必须是结构化的失败，不能带着半个 fixture 中止整个基准。
 */
export function runNegativeCanary(
  scenario: Scenario,
  modes: Mode[] = modesFor(scenario),
): CanaryOutcome {
  const canary = scenario.negativeCanary;
  if (!canary) return { passed: true, failures: [] };
  const fallback = modes[0] ?? "direct";
  const failures: CanaryFailure[] = [];

  let root: string;
  try {
    root = createFixture(scenario);
  } catch (error) {
    return {
      passed: false,
      failures: [{ mode: fallback, reason: `fixture 创建失败：${describeError(error)}` }],
    };
  }

  try {
    const file = join(root, canary.file);
    const original = readFileSync(file, "utf8");
    if (!original.includes(canary.search)) {
      failures.push({ mode: fallback, reason: `canary 片段在 fixture 中不存在：${canary.search}` });
    } else {
      writeFileSync(file, original.replace(canary.search, canary.replace));
      for (const mode of modes) {
        const result = runOnce(fullCommand(mode, buildArgs(mode, root, scenario, "cold")), root);
        const reason = checkCanaryResult(canary, mode, result);
        if (reason) failures.push({ mode, reason });
      }
    }
  } catch (error) {
    failures.push({ mode: fallback, reason: `负向预检自身出错：${describeError(error)}` });
  } finally {
    // 目录马上要删，恢复被改写的文件没有意义；删不掉必须记成失败，不能当通过
    try {
      removeFixture(root);
    } catch (error) {
      failures.push({
        mode: fallback,
        reason: `fixture 清理失败（${root}）：${describeError(error)}`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * 单独跑一轮带内存探针的运行，与计时轮分开，免得探针开销混进 wall-clock。
 * maxRSS 只覆盖被测进程自身：wrapper 还会 spawn 一个 vue-tsc 子进程，
 * 那部分内存不在其中，报告里必须写明这一点。
 */
export function measureRss(command: string[], cwd: string): number | undefined {
  const rssFile = join(cwd, `.rss-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    const result = spawnSync(process.execPath, ["--require", RSS_PROBE, ...command], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, BENCH_RSS_FILE: rssFile },
    });
    if (result.status === null) return undefined;
    const raw = readFileSync(rssFile, "utf8").trim();
    return raw ? Number(raw) : undefined;
  } catch {
    // 探针没写出结果就当作未测量，不让辅助手段变成基准的失败原因
    return undefined;
  } finally {
    rmSync(rssFile, { force: true });
  }
}

export interface ExtendedDiagnostics {
  parseMs: number;
  bindMs: number;
  checkMs: number;
  totalMs: number;
}

/**
 * 解析 --extendedDiagnostics 输出。只覆盖编译器内部阶段，不含 Node 启动、
 * 配置解析与 wrapper 准备成本，因此不能单独当作端到端耗时。
 */
export function parseExtendedDiagnostics(text: string): ExtendedDiagnostics | undefined {
  const grab = (label: string): number => {
    const match = new RegExp(`^${label} time[^\\d]*(\\d+(?:\\.\\d+)?)s`, "m").exec(text);
    return match?.[1] === undefined ? Number.NaN : Number(match[1]) * 1000;
  };
  const totalMs = grab("Total");
  if (Number.isNaN(totalMs)) return undefined;
  return { parseMs: grab("Parse"), bindMs: grab("Bind"), checkMs: grab("Check"), totalMs };
}

export interface Summary {
  n: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  /**
   * 四分位距。比极差稳健得多：机器上偶发的一次抢占就能把极差拉到和
   * 场景间差值同一量级，用极差判断收益高低基本是在自欺。
   */
  iqrMs: number;
  /** IQR 相对中位数的比例，超过它说明这一格的结论不可信 */
  noiseRatio: number;
}

export function summarize(samples: number[]): Summary {
  if (samples.length === 0) throw new Error("没有样本");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const quantile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const iqrMs = quantile(0.75) - quantile(0.25);
  return {
    n: samples.length,
    medianMs,
    minMs,
    maxMs,
    iqrMs,
    noiseRatio: medianMs === 0 ? 0 : iqrMs / medianMs,
  };
}

/** IQR 超过中位数的这个比例，就不要拿这一格去比场景间差异了 */
export const NOISE_THRESHOLD = 0.25;

/** 准备成本：只解析参数、生成临时配置、定位 vue-tsc 入口，不启动编译器 */
export function runPrep(root: string, scenario: Scenario): RunResult {
  return runOnce([PREP_SCRIPT, ...(scenario.wrapperArgs ?? scenario.targets)], root);
}

/** 冷启动地板：Node 起来什么都不做 */
export function runNodeBaseline(cwd: string): RunResult {
  return runOnce(["-e", "0"], cwd);
}

export function assertCliBuilt(): void {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`构建产物缺失：${CLI_PATH}（pnpm bench 会先自动 build）`);
  }
}
