/**
 * 基准场景定义。每个场景给出一份 fixture（文件 + tsconfig）、wrapper 要检查的
 * 目标文件，以及这次运行"本该"发生什么——退出码、关键输出、期望诊断行数。
 *
 * 期望值不是装饰：harness 每次运行都会校验，不过直接判失败退出。
 * 否则一次因为 fixture 写坏而"跑得很快"的运行会被当成漂亮的基准点，
 * 这正是 #23 要防的测量误判。
 */

/** 两种模式共用的编译选项。显式写全，避免 wrapper 的默认值让对照不等价。 */
const BASE_COMPILER_OPTIONS = {
  strict: true,
  target: "ES2023",
  module: "ESNext",
  moduleResolution: "Bundler",
  skipLibCheck: true,
  noEmit: true,
  // 切断 @types 自动引入，否则类型集合取决于开发机装了哪些 @types
  types: [] as string[],
} as const;

/** 零填充，保证文件名字典序与生成序一致 */
function pad(index: number, width = 3): string {
  return String(index).padStart(width, "0");
}

export interface ScenarioExpectation {
  /** 期望退出码：类型诊断失败是 2，用法错误是 1，正常通过是 0 */
  exit: number;
  /**
   * incremental 缓存建立之后的期望退出码，**只对 direct 生效**。
   * direct 命中 .tsbuildinfo 时 TypeScript 跳过重新检查，诊断照打但退出码
   * 从 2 变成 1；wrapper 按设计把 buildinfo 重定向到临时文件并删除，
   * 每次都是"首次"，退出码不变。不填表示 direct 与 wrapper 都用 exit。
   */
  directExitAfterWarmCache?: number;
  /** 必须能在 stdout 里匹配到的内容 */
  stdout?: RegExp[];
  /** 必须能在 stderr 里匹配到的内容 */
  stderr?: RegExp[];
  /**
   * 诊断行的期望条数（精确值）。故意制造错误的场景必须锁住它，
   * 防止"因为整个检查崩了所以没有输出"被当成通过。
   */
  diagnosticLines?: number;
}

export interface Scenario {
  name: string;
  description: string;
  /** fixture 文件：相对路径 -> 内容 */
  files: Record<string, string>;
  /** 场景自带的 tsconfig.json（两种模式共用同一份，是等价对照的基础） */
  tsconfig: unknown;
  /** wrapper 要检查的目标文件，相对 fixture 根 */
  targets: string[];
  /** 覆盖 wrapper 的默认参数；不填就是 targets（filter 模式再加 flag） */
  wrapperArgs?: string[];
  /** 是否与"直接 vue-tsc"可比；Git 无目标这类场景没有对照方 */
  comparable?: boolean;
  /** 是否需要 git 仓库 */
  git?: boolean;
  /** 等价性说明，原样打到输出里 */
  equivalence: string;
  expect: ScenarioExpectation;
}

/** n 个 import 同一 seed 的小模块 */
function importingModules(
  dir: string,
  prefix: string,
  count: number,
  width = 3,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    files[`${dir}/${prefix}${pad(i, width)}.ts`] =
      `import { seed } from "${dir === "src" ? "./seed" : "../seed"}";\n` +
      `export const value${prefix}${i}: number = seed + ${i};\n`;
  }
  return files;
}

/** large-diagnostics 的规模：60 个候选文件 × 每文件 3 处错误，检查其中 10 个 */
const NOISY_FILE_COUNT = 60;
const NOISY_ERRORS_PER_FILE = 3;
const NOISY_TARGET_COUNT = 10;

const noisyFiles = Object.fromEntries(
  Array.from({ length: NOISY_FILE_COUNT }, (_, i) => [
    `src/noisy/n${pad(i)}.ts`,
    `export const bad${i}a: number = "a";\n` +
      `export const bad${i}b: string = ${i};\n` +
      `export function bad${i}c(): void { return ${i}; }\n`,
  ]),
);

export const SCENARIOS: Scenario[] = [
  {
    name: "simple-ts",
    description: "少量独立 .ts 文件，无错误。最小可复现基线，对应 issue 里的复现脚本。",
    files: {
      "src/seed.ts": "export const seed: number = 1;\n",
      ...importingModules("src", "mod", 5),
    },
    tsconfig: { compilerOptions: BASE_COMPILER_OPTIONS, include: ["src"] },
    targets: Array.from({ length: 5 }, (_, i) => `src/mod${pad(i)}.ts`),
    equivalence: "两模式共用同一份 tsconfig.json，检查文件集合相同",
    expect: { exit: 0, diagnosticLines: 0 },
  },
  {
    name: "vue-sfc",
    description:
      '真实 .vue SFC（<script setup lang="ts"> + template）走 vue-tsc 的 SFC 变换管线，' +
      "并 import 了 .ts 依赖。只用简单 TS fixture 证明不了 Vue 项目的成本。",
    files: {
      "src/seed.ts": "export const seed: number = 1;\n",
      ...Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [
          `src/Comp${i}.vue`,
          `<script setup lang="ts">\n` +
            `import { seed } from "./seed";\n` +
            `const count${i}: number = seed + ${i};\n` +
            `</script>\n` +
            `<template><p class="c${i}">{{ count${i} }}</p></template>\n`,
        ]),
      ),
    },
    tsconfig: { compilerOptions: BASE_COMPILER_OPTIONS, include: ["src"] },
    targets: Array.from({ length: 3 }, (_, i) => `src/Comp${i}.vue`),
    equivalence: "两模式共用同一份 tsconfig.json，SFC 与其传递依赖构成相同的检查集合",
    expect: { exit: 0, diagnosticLines: 0 },
  },
  {
    name: "wide-include",
    description:
      "tsconfig 的 include 覆盖 200 个文件，但只检查其中 2 个。考察 wrapper 为收集 .d.ts " +
      "而遍历 include 范围的代价，对应 #27 的测量面。",
    files: {
      "src/seed.ts": "export const seed: number = 1;\n",
      ...Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `src/bulk/b${pad(i)}.ts`,
          `export const bulk${i}: number = ${i};\n`,
        ]),
      ),
      ...importingModules("src/wide", "w", 2),
    },
    tsconfig: { compilerOptions: BASE_COMPILER_OPTIONS, include: ["src"] },
    targets: ["src/wide/w000.ts", "src/wide/w001.ts"],
    equivalence:
      "检查文件集合相同；差异正是被测成本——wrapper 需遍历 200 个文件的 include 范围收集 .d.ts，" +
      "direct 走 control 配置的 files，不做这次枚举",
    expect: { exit: 0, diagnosticLines: 0 },
  },
  {
    name: "git-no-target",
    description: "git 仓库中无暂存变更，`--staged` 走早退路径，不启动 vue-tsc。",
    files: { "src/seed.ts": "export const seed: number = 1;\n" },
    tsconfig: { compilerOptions: BASE_COMPILER_OPTIONS, include: ["src"] },
    targets: [],
    wrapperArgs: ["--staged"],
    comparable: false,
    git: true,
    equivalence: "没有直接 vue-tsc 的对照方：这是 wrapper 独有的文件收集阶段",
    expect: { exit: 0, stdout: [/No staged files to type-check/], diagnosticLines: 0 },
  },
  {
    name: "large-diagnostics",
    description:
      `检查 ${NOISY_TARGET_COUNT} 个制造了大量类型错误的文件（共 ` +
      `${NOISY_FILE_COUNT} 个候选文件，每个 ${NOISY_ERRORS_PER_FILE} 处错误）。考察诊断体量对 ` +
      "wrapper 的影响，对应 #25 的测量面。",
    files: noisyFiles,
    tsconfig: { compilerOptions: BASE_COMPILER_OPTIONS, include: ["src"] },
    targets: Array.from({ length: NOISY_TARGET_COUNT }, (_, i) => `src/noisy/n${pad(i)}.ts`),
    equivalence:
      "两模式检查同一批文件、输出同样的诊断行；差值反映输出体量本身带来的开销。" +
      "incremental 下 direct 命中 .tsbuildinfo 后退出码由 2 变 1，wrapper 因隔离缓存恒为 2",
    expect: {
      exit: 2,
      directExitAfterWarmCache: 1,
      diagnosticLines: NOISY_TARGET_COUNT * NOISY_ERRORS_PER_FILE,
    },
  },
];
