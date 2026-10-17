import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import {
  CLI_PATH,
  NOISE_THRESHOLD,
  VUE_TSC_ENTRY,
  assertCliBuilt,
  buildArgs,
  createFixture,
  fullCommand,
  measureRss,
  modesFor,
  parseExtendedDiagnostics,
  removeFixture,
  runNegativeCanary,
  runNodeBaseline,
  runPrep,
  runOnce,
  summarize,
  validate,
  type CacheMode,
  type Mode,
  type Summary,
} from "./harness.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const require = createRequire(import.meta.url);
const ALL_CACHE_MODES: CacheMode[] = ["cold", "warm", "incremental"];

interface Options {
  runs: number;
  cacheModes: CacheMode[];
  scenarios: Scenario[];
  jsonPath: string | undefined;
  /** 上一次的结果 JSON，用于比对节点基线并提示机器是否被占用 */
  comparePath: string | undefined;
}

interface Cell {
  scenario: string;
  mode: Mode;
  cacheMode: CacheMode;
  summary: Summary;
  rssMb: number | undefined;
  diagnostics: { parseMs: number; bindMs: number; checkMs: number; totalMs: number } | undefined;
  prepMs: number | undefined;
}

interface Failure {
  cell: string;
  reason: string;
}

function parseOptions(argv: string[]): Options {
  let runs = 7;
  let cacheModes = ALL_CACHE_MODES;
  let only: string | undefined;
  let jsonPath: string | undefined;
  let comparePath: string | undefined;
  let quick = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quick") {
      quick = true;
    } else if (arg === "--runs") {
      runs = Number(argv[++i]);
    } else if (arg === "--cache") {
      cacheModes = (argv[++i] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is CacheMode => (ALL_CACHE_MODES as string[]).includes(value));
    } else if (arg === "--scenario") {
      only = argv[++i];
    } else if (arg === "--json") {
      jsonPath = argv[++i];
    } else if (arg === "--compare") {
      comparePath = argv[++i];
    } else {
      throw new Error(
        `未知参数 ${arg}\n用法：node bench/run.ts [--runs N] [--quick] [--scenario 名称] [--cache cold,warm,incremental] [--json 路径] [--compare 上次结果.json]`,
      );
    }
  }

  if (quick) {
    runs = Math.min(runs, 3);
    cacheModes = cacheModes.includes("warm") ? ["warm"] : cacheModes;
  }
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs 需要正整数，收到 ${runs}`);
  }
  if (cacheModes.length === 0) {
    throw new Error("--cache 至少要一个有效值");
  }

  const scenarios = only ? SCENARIOS.filter((scenario) => scenario.name === only) : SCENARIOS;
  if (scenarios.length === 0) {
    throw new Error(`没有名为 ${only} 的场景，可用：${SCENARIOS.map((s) => s.name).join(", ")}`);
  }
  return { runs, cacheModes, scenarios, jsonPath, comparePath };
}

/**
 * 机器被占用时，所有格子的数字会一起抬高，横向比较仍有意义、纵向跨轮比较则毫无意义。
 * Node 空进程基线是唯一不受项目规模影响的量：它比历史值明显偏高，就说明这一轮整体不可信。
 */
const NODE_BASELINE_TOLERANCE = 1.5;

function checkEnvironment(current: Summary, comparePath: string | undefined): void {
  if (!comparePath) return;
  let previous: { nodeBaseline?: { medianMs?: number } };
  try {
    previous = JSON.parse(readFileSync(comparePath, "utf8"));
  } catch (error) {
    console.log(
      `无法读取对照文件 ${comparePath}：${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  const previousMs = previous.nodeBaseline?.medianMs;
  if (typeof previousMs !== "number" || previousMs <= 0) {
    console.log(`对照文件缺少可用的 Node 基线，跳过机器负载检查。`);
    return;
  }
  const ratio = current.medianMs / previousMs;
  if (ratio > NODE_BASELINE_TOLERANCE) {
    console.log(
      `⚠ 机器负载告警：Node 空进程基线 ${ms(current.medianMs)} ms，` +
        `是上次（${ms(previousMs)} ms）的 ${ratio.toFixed(2)} 倍。` +
        `这一轮的数字整体偏高，不要与历史结果直接比较；请在机器空闲时重测。`,
    );
  } else {
    console.log(
      `机器负载正常：Node 空进程基线 ${ms(current.medianMs)} ms（上次 ${ms(previousMs)} ms）。`,
    );
  }
}

/** 冷缓存：每次运行都用全新的 fixture 目录 */
function measureCold(scenario: Scenario, mode: Mode, runs: number, failures: Failure[]) {
  const samples: number[] = [];
  let rssMb: number | undefined;
  for (let i = 0; i < runs; i++) {
    const root = createFixture(scenario);
    try {
      const args = buildArgs(mode, root, scenario, "cold");
      const result = runOnce(fullCommand(mode, args), root);
      const failure = validate(scenario, mode, "cold", root, result);
      if (failure) {
        failures.push(failure);
        return { samples, rssMb };
      }
      samples.push(result.wallMs);
      if (i === 0) rssMb = toMb(measureRss(fullCommand(mode, args), root));
    } finally {
      removeFixture(root);
    }
  }
  return { samples, rssMb };
}

/** 热缓存与增量缓存：fixture 复用；增量模式额外先跑一轮把编译器缓存灌热 */
function measureWarm(
  scenario: Scenario,
  mode: Mode,
  cacheMode: "warm" | "incremental",
  runs: number,
  failures: Failure[],
) {
  const samples: number[] = [];
  let rssMb: number | undefined;
  const root = createFixture(scenario);
  try {
    if (cacheMode === "incremental") {
      // 灌热的一轮同样要过校验：缓存建立本身也可能悄悄失败
      const prime = runOnce(fullCommand(mode, buildArgs(mode, root, scenario, cacheMode)), root);
      const failure = validate(scenario, mode, cacheMode, root, prime);
      if (failure) {
        failures.push(failure);
        return { samples, rssMb };
      }
    }
    for (let i = 0; i < runs; i++) {
      const args = buildArgs(mode, root, scenario, cacheMode);
      const result = runOnce(fullCommand(mode, args), root);
      // incremental 下从这里起缓存已经存在，退出码期望值随之改变
      const failure = validate(
        scenario,
        mode,
        cacheMode,
        root,
        result,
        cacheMode === "incremental",
      );
      if (failure) {
        failures.push(failure);
        return { samples, rssMb };
      }
      samples.push(result.wallMs);
      if (i === 0) rssMb = toMb(measureRss(fullCommand(mode, args), root));
    }
  } finally {
    removeFixture(root);
  }
  return { samples, rssMb };
}

/** 单独几轮 extendedDiagnostics，与主计时轮分开；单轮抖动太大，取中位数 */
function measureDiagnostics(
  scenario: Scenario,
  mode: Mode,
  cacheMode: CacheMode,
): Cell["diagnostics"] {
  const samples: { parseMs: number; bindMs: number; checkMs: number; totalMs: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const root = createFixture(scenario);
    try {
      const args = buildArgs(mode, root, scenario, cacheMode, { extendedDiagnostics: true });
      const result = runOnce(fullCommand(mode, args), root);
      if (validate(scenario, mode, cacheMode, root, result)) continue;
      const parsed = parseExtendedDiagnostics(`${result.stdout}${result.stderr}`);
      if (parsed) samples.push(parsed);
    } finally {
      removeFixture(root);
    }
  }
  if (samples.length === 0) return undefined;
  const pick = (key: "parseMs" | "bindMs" | "checkMs" | "totalMs") =>
    summarize(samples.map((sample) => sample[key])).medianMs;
  return {
    parseMs: pick("parseMs"),
    bindMs: pick("bindMs"),
    checkMs: pick("checkMs"),
    totalMs: pick("totalMs"),
  };
}

function toMb(kb: number | undefined): number | undefined {
  return kb === undefined ? undefined : Math.round((kb / 1024) * 10) / 10;
}

function padEnd(text: string, width: number): string {
  // 中文按两个终端列宽算，否则表格会错位
  let display = 0;
  let out = "";
  for (const char of text) {
    const charWidth = /[^\x20-\x7e]/.test(char) ? 2 : 1;
    if (display + charWidth > width) return `${out}${" ".repeat(Math.max(width - display, 1))}`;
    out += char;
    display += charWidth;
  }
  return out + " ".repeat(Math.max(width - display, 0));
}

function ms(value: number): string {
  return value.toFixed(1);
}

/** 按内容算列宽，避免场景名过长时两列粘在一起 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ""))),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => padEnd(cell, widths[index] ?? 10)).join("  ");
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[^\x20-\x7e]/.test(char) ? 2 : 1;
  return width;
}

function printEnvironment(): void {
  const tsVersion = require("typescript/package.json").version;
  const vueTscVersion = require("vue-tsc/package.json").version;
  console.log("vue-tsc-files 性能基准");
  console.log(
    `${process.platform} ${process.arch} / Node ${process.version} / ` +
      `TypeScript ${tsVersion} / vue-tsc ${vueTscVersion}`,
  );
  console.log(`被测产物：${CLI_PATH}`);
  console.log(`对照入口：${VUE_TSC_ENTRY}`);
  console.log("注意：请单独运行，不要与构建或 pnpm test 并行；机器负载与文件缓存都会污染结果。");
  console.log("");
}

function printTable(cells: Cell[], failures: Failure[]): void {
  // 同一场景同一缓存下相对 direct 的中位数差：wrapper 到底多付了多少
  const baseline = new Map<string, number>();
  for (const cell of cells) {
    if (cell.mode === "direct") {
      baseline.set(`${cell.scenario}/${cell.cacheMode}`, cell.summary.medianMs);
    }
  }
  const deltaOf = (cell: Cell): string => {
    if (cell.mode === "direct") return "-";
    const reference = baseline.get(`${cell.scenario}/${cell.cacheMode}`);
    if (reference === undefined) return "无对照";
    const delta = cell.summary.medianMs - reference;
    return `${delta >= 0 ? "+" : ""}${ms(delta)}`;
  };

  console.log(
    renderTable(
      [
        "场景",
        "模式",
        "缓存",
        "n",
        "中位数",
        "最小",
        "最大",
        "IQR",
        "Δdirect",
        "自身RSS",
        "Parse",
        "Check",
        "编译器Total",
      ],
      cells.map((cell) => [
        cell.scenario,
        cell.mode,
        cell.cacheMode,
        String(cell.summary.n),
        ms(cell.summary.medianMs),
        ms(cell.summary.minMs),
        ms(cell.summary.maxMs),
        cell.summary.noiseRatio > NOISE_THRESHOLD
          ? `${ms(cell.summary.iqrMs)} !`
          : ms(cell.summary.iqrMs),
        deltaOf(cell),
        cell.rssMb === undefined ? "-" : `${cell.rssMb} MB`,
        cell.diagnostics ? ms(cell.diagnostics.parseMs) : "-",
        cell.diagnostics ? ms(cell.diagnostics.checkMs) : "-",
        cell.diagnostics ? ms(cell.diagnostics.totalMs) : "-",
      ]),
    ),
  );
  console.log("");
  console.log("单位：毫秒。Δdirect = 同场景同缓存下相对 direct 的中位数差。");
  console.log(
    `IQR 是四分位距而非极差：偶发的一次抢占就能把极差拉到与场景间差值同一量级。` +
      `标记 ! 的格子其 IQR 超过中位数的 ${Math.round(NOISE_THRESHOLD * 100)}%，` +
      `这一格的数字不要拿去比较，加 --runs 重测。`,
  );
  console.log(
    "自身 RSS 只含被测进程：wrapper 会再 spawn 一个 vue-tsc 子进程，那部分不在其中。" +
      "因此 direct 与 wrapper 的 RSS 不是同口径，不能直接比大小。",
  );
  console.log(
    "Parse/Check/编译器 Total 取自单独一轮 --extendedDiagnostics 的中位数（n≤3），" +
      "只覆盖编译器内部阶段，不含 Node 启动、配置解析与 wrapper 准备成本。",
  );
  console.log(
    "wrapper-filter 走的是缓冲输出而非 stdio 继承（需要捕获输出做归属解析），" +
      "因此它比 wrapper 慢属结构性差异，不代表过滤逻辑本身更耗时。",
  );

  if (failures.length > 0) {
    console.log("");
    console.log(`校验失败 ${failures.length} 处，基准结果不可信：`);
    for (const failure of failures) {
      console.log(`  [${failure.cell}] ${failure.reason}`);
    }
  }
}

function printNotes(scenarios: Scenario[], cells: Cell[]): void {
  console.log("");
  console.log("等价性与口径：");
  for (const scenario of scenarios) {
    console.log(`  ${scenario.name} — ${scenario.equivalence}`);
  }
  const prepCells = cells.filter((cell) => cell.prepMs !== undefined);
  if (prepCells.length > 0) {
    console.log("");
    console.log(
      "wrapper 准备成本（解析参数 + 生成临时 tsconfig + 定位 vue-tsc 入口，不含编译器）：",
    );
    for (const cell of prepCells) {
      console.log(`  ${padEnd(cell.scenario, 20)}${ms(cell.prepMs ?? 0)} ms`);
    }
    console.log("  注意：该数字含 Node 启动与模块加载，与总耗时之差只能粗略看作编译阶段。");
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  assertCliBuilt();
  printEnvironment();

  const cells: Cell[] = [];
  const failures: Failure[] = [];
  const timedRuns = options.scenarios.reduce(
    (sum, scenario) => sum + modesFor(scenario).length * options.cacheModes.length * options.runs,
    0,
  );
  console.log(
    `共 ${options.scenarios.length} 个场景，主计时轮约 ${timedRuns} 次运行` +
      `（另有负向预检、分阶段与内存的补充轮次，都不计时），请稍候。`,
  );
  console.log("");

  const baselineRoot = createFixture(SCENARIOS[0]!);
  const nodeBaseline = summarize(
    Array.from({ length: options.runs }, () => runNodeBaseline(baselineRoot).wallMs),
  );
  removeFixture(baselineRoot);
  console.log(`Node 空进程基线：中位数 ${ms(nodeBaseline.medianMs)} ms（所有数字的地板）`);
  checkEnvironment(nodeBaseline, options.comparePath);
  console.log("");

  for (const scenario of options.scenarios) {
    console.log(`▸ ${scenario.name} — ${scenario.description}`);
    // 负向预检必须在计时之前：它证明这个场景真的在检查类型，
    // 它的耗时也不计入任何一格数字
    const canary = runNegativeCanary(scenario);
    if (!canary.passed) {
      console.log("  ⚠ 负向预检未通过，本场景全部数字已丢弃（原因见文末校验失败列表）。");
      for (const failure of canary.failures) {
        failures.push({
          cell: `${scenario.name} / ${failure.mode} / negative-canary`,
          reason: failure.reason,
        });
      }
      console.log("");
      continue;
    }
    if (scenario.negativeCanary) console.log("  ✓ 负向预检通过：坏属性在三种模式下都被准确拒绝。");
    let prepMs: number | undefined;
    for (const mode of modesFor(scenario)) {
      for (const cacheMode of options.cacheModes) {
        const measured =
          cacheMode === "cold"
            ? measureCold(scenario, mode, options.runs, failures)
            : measureWarm(scenario, mode, cacheMode, options.runs, failures);
        if (measured.samples.length === 0) continue;
        if (prepMs === undefined && mode === "wrapper") {
          const prepRoot = createFixture(scenario);
          try {
            prepMs = runPrep(prepRoot, scenario).wallMs;
          } finally {
            removeFixture(prepRoot);
          }
        }
        cells.push({
          scenario: scenario.name,
          mode,
          cacheMode,
          summary: summarize(measured.samples),
          rssMb: measured.rssMb,
          // 分阶段耗时只在 warm 下取：冷/增量下这个数字没有横向参考价值，
          // 却是矩阵里最贵的一段（每个格子要额外跑三轮）
          diagnostics:
            cacheMode === "warm" ? measureDiagnostics(scenario, mode, cacheMode) : undefined,
          prepMs: cacheMode === "warm" && mode === "wrapper" ? prepMs : undefined,
        });
      }
    }
    console.log("");
  }

  printTable(cells, failures);
  printNotes(options.scenarios, cells);

  if (options.jsonPath) {
    const path = resolve(options.jsonPath);
    writeFileSync(
      path,
      JSON.stringify(
        {
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          runs: options.runs,
          nodeBaseline,
          cells,
          failures,
          scenarios: options.scenarios.map((scenario) => ({
            name: scenario.name,
            equivalence: scenario.equivalence,
            expect: scenario.expect,
          })),
        },
        null,
        2,
      ),
    );
    console.log("");
    console.log(`JSON 结果已写入 ${path}`);
  }

  // 门槛不在本 issue 里预设：先有基线数字，再由数字决定门槛
  process.exitCode = failures.length > 0 ? 1 : 0;
}

await main();
