import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  lstatSync,
  statSync,
  linkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join } from "path";
import { createRequire } from "module";
import {
  getTscFiles,
  randomChars,
  setupArgs,
  createAndSetupTsConfig,
  getInternalTsBuildInfoFile,
  filterErrorsInFiles,
  getDiagnosticExitResult,
  stripAnsiCodes,
  parseGitStatusPorcelain,
  parseInstallArgs,
  getSkillInstallTarget,
  installSkill,
  getPackageVersion,
  formatVersion,
} from "../src/util.ts";

const require = createRequire(import.meta.url);

/** 在替换 process.argv 的上下文中调用 setupArgs */
function withArgv(args: string[], fn: () => void) {
  const original = process.argv;
  process.argv = [original[0]!, original[1]!, ...args];
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

test("getTscFiles 扩展名匹配大小写不敏感", () => {
  assert.deepEqual(getTscFiles(["A.TS", "B.Vue", "c.Tsx", "d.MTS", "e.js", "f.json"]), [
    "A.TS",
    "B.Vue",
    "c.Tsx",
    "d.MTS",
  ]);
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

test("setupArgs 大量参数保持顺序、去重及透传语义", () => {
  const targets = Array.from({ length: 3000 }, (_, i) => `src/file-${i}.ts`);
  withArgv(["--pretty", "false", ...targets, "-p", "config.json", ...targets, "--noEmit"], () => {
    const { files, specifiedFiles, projectValue, remainingArgsToForward } = setupArgs();
    assert.deepEqual(specifiedFiles, targets);
    assert.deepEqual(files, targets);
    assert.notEqual(files, specifiedFiles);
    assert.equal(projectValue, "config.json");
    assert.deepEqual(remainingArgsToForward, ["--pretty", "false", "--noEmit"]);
  });
});

test("setupArgs 仅将 project 值作为 project 处理，不再把 -p 值当文件预扫描", () => {
  for (const projectArgs of [
    ["-p", "config.ts"],
    ["--project", "config.ts"],
    ["--project=config.ts"],
    ["-p=config.ts"],
  ]) {
    withArgv(["first.vue", ...projectArgs, "--strict", "false", "first.vue"], () => {
      const { specifiedFiles, projectValue, remainingArgsToForward } = setupArgs();
      // 连写/分写的 project 值只作 project 处理：长着源文件扩展名也不进文件列表
      assert.deepEqual(specifiedFiles, ["first.vue"]);
      assert.equal(projectValue, "config.ts");
      assert.deepEqual(remainingArgsToForward, ["--strict", "false"]);
    });
  }
  withArgv(["a.ts", "-p", "--help", "--project=last.json", "--pretty"], () => {
    const { projectValue, remainingArgsToForward } = setupArgs();
    // -p 会把下一个 token（哪怕是 --help）当作自己的值消费掉，不触发 help
    assert.equal(projectValue, "last.json");
    assert.deepEqual(remainingArgsToForward, ["--pretty"]);
  });
});

test("setupArgs boolean/未知 flag 后的源文件仍是文件，顺序与去重保持", () => {
  withArgv(["src/b.ts", "--strict", "src/a.ts", "--unknown-flag", "src/c.vue", "src/b.ts"], () => {
    const { specifiedFiles, remainingArgsToForward } = setupArgs();
    assert.deepEqual(specifiedFiles, ["src/b.ts", "src/a.ts", "src/c.vue"]);
    assert.deepEqual(remainingArgsToForward, ["--strict", "--unknown-flag"]);
  });
});

test("setupArgs string/list option 消费以源文件扩展名结尾的值", () => {
  for (const [option, value] of [
    ["--outDir", "dist.ts"],
    ["--lib", "es2020.ts"],
  ] as const) {
    withArgv([option, value, "src/a.ts"], () => {
      const { specifiedFiles, remainingArgsToForward } = setupArgs();
      // 值被 option 消费：转发但不进文件列表
      assert.deepEqual(specifiedFiles, ["src/a.ts"]);
      assert.deepEqual(remainingArgsToForward, [option, value]);
    });
  }
});

test("setupArgs 同名文件与 option 值并存时各自归类", () => {
  withArgv(["--outDir", "namesake.ts", "namesake.ts"], () => {
    const { specifiedFiles, remainingArgsToForward } = setupArgs();
    // 第一个 namesake.ts 是 --outDir 的值，第二个才是源文件
    assert.deepEqual(specifiedFiles, ["namesake.ts"]);
    assert.deepEqual(remainingArgsToForward, ["--outDir", "namesake.ts"]);
  });
});

test("setupArgs 以 - 开头的 token 不当源文件，./-foo.ts 形式不受影响", () => {
  withArgv(["-foo.ts", "./-bar.ts"], () => {
    const { specifiedFiles, remainingArgsToForward } = setupArgs();
    assert.deepEqual(specifiedFiles, ["./-bar.ts"]);
    assert.deepEqual(remainingArgsToForward, ["-foo.ts"]);
  });
});

test("setupArgs 识别单双横线与大小写的 project 全变体", () => {
  // tsc 大小写不敏感、单双横线等价：这些形式都是 --project，不得落进转发参数
  for (const projectArgs of [
    ["-p", "other.json"],
    ["--p", "other.json"],
    ["-project", "other.json"],
    ["--project", "other.json"],
    ["-P", "other.json"],
    ["--PROJECT", "other.json"],
    ["--p=other.json"],
    ["-project=other.json"],
    ["--Project=other.json"],
  ]) {
    withArgv([...projectArgs, "a.ts"], () => {
      const { projectValue, specifiedFiles, remainingArgsToForward } = setupArgs();
      assert.equal(projectValue, "other.json");
      assert.deepEqual(specifiedFiles, ["a.ts"]);
      assert.deepEqual(remainingArgsToForward, []);
    });
  }
});

test("setupArgs 完整上下文判定源文件（--outDir --outDir / list 值消费）", () => {
  // TS 语义：第一个 --outDir 的值是第二个 --outDir；other.ts 仍是源文件
  withArgv(["--outDir", "--outDir", "other.ts", "good.ts"], () => {
    const { specifiedFiles, remainingArgsToForward } = setupArgs();
    assert.deepEqual(specifiedFiles, ["other.ts", "good.ts"]);
    assert.deepEqual(remainingArgsToForward, ["--outDir", "--outDir"]);
  });
  for (const projectArgs of [
    ["--project", "other.json"],
    ["--p", "other.json"],
    ["-project", "other.json"],
    ["--project=other.json"],
  ]) {
    withArgv(["--types", ...projectArgs, "good.ts", "plain.ts"], () => {
      const { projectValue, specifiedFiles, remainingArgsToForward } = setupArgs();
      assert.equal(projectValue, "other.json");
      assert.deepEqual(specifiedFiles, ["good.ts", "plain.ts"]);
      assert.deepEqual(remainingArgsToForward, ["--types"]);
    });
  }
  withArgv(["--outDir", "namesake.ts", "--strict", "namesake.ts"], () => {
    const { specifiedFiles, remainingArgsToForward } = setupArgs();
    assert.deepEqual(specifiedFiles, ["namesake.ts"]);
    assert.deepEqual(remainingArgsToForward, ["--outDir", "namesake.ts", "--strict"]);
  });
});

test("setupArgs 显式文件按首次出现顺序去重，files 与 specifiedFiles 独立", () => {
  withArgv(["src/b.vue", "src/a.ts", "src/b.vue", "src/c.ts", "src/a.ts"], () => {
    const { files, specifiedFiles } = setupArgs();
    assert.deepEqual(specifiedFiles, ["src/b.vue", "src/a.ts", "src/c.ts"]);
    assert.deepEqual(files, specifiedFiles);
    assert.notEqual(files, specifiedFiles);
    files.push("env.d.ts");
    assert.deepEqual(specifiedFiles, ["src/b.vue", "src/a.ts", "src/c.ts"]);
  });
});

for (const [name, status, output, exitCode, ignoredDependencyErrors] of [
  ["status 0 优先于诊断", 0, "src/a.ts(1,1): error TS2322: x", 0, false],
  ["null 加空输出", null, "", 1, false],
  ["null 加仅依赖诊断仍失败", null, "dep.ts(1,1): error TS2322: x", 1, false],
  ["目标诊断保留原状态", 2, "src/a.ts(1,1): error TS2322: x", 2, false],
  ["null 加目标诊断", null, "src/a.ts(1,1): error TS2322: x", 1, false],
  ["全局诊断保留原状态", 3, "error TS5083: Cannot read file", 3, false],
  ["null 加全局诊断", null, "error TS5083: Cannot read file", 1, false],
  ["仅依赖诊断", 2, "dep.ts(1,1): error TS2322: x", 0, true],
  ["Windows 中断加依赖诊断仍失败", 1, "dep.ts(1,1): error TS2322: x", 1, false],
  ["异常退出加依赖诊断仍失败", 7, "dep.ts(1,1): error TS2322: x", 7, false],
  ["无诊断崩溃", 7, "Error: vue-tsc crashed", 7, false],
  ["非零加空输出", 2, "", 2, false],
  ["pretty 目标诊断", 2, "src/a.ts:1:7 - error TS2322: x", 2, false],
  [
    "pretty ANSI 目标诊断",
    2,
    "\x1b[96msrc/a.ts\x1b[0m:1:7 - \x1b[91merror\x1b[0m TS2322: x",
    2,
    false,
  ],
  [
    "pretty ANSI 依赖诊断",
    2,
    "\x1b[96mdep.ts\x1b[0m:1:7 - \x1b[91merror\x1b[0m TS2322: x",
    0,
    true,
  ],
] as const) {
  test(`getDiagnosticExitResult ${name}`, () => {
    assert.deepEqual(getDiagnosticExitResult(status, output, ["src/a.ts"]), {
      exitCode,
      ignoredDependencyErrors,
    });
  });
}

test("getDiagnosticExitResult 把临时配置路径上的配置诊断归为全局错误", () => {
  // 普通格式与 --pretty 格式（path:line:col - error）同样算数，不按依赖错误豁免
  assert.deepEqual(
    getDiagnosticExitResult(
      2,
      "tsconfig.abc123.json(3,5): error TS5023: Unknown compiler option 'foo'.",
      ["src/a.ts"],
      "tsconfig.abc123.json",
    ),
    { exitCode: 2, ignoredDependencyErrors: false },
  );
  assert.deepEqual(
    getDiagnosticExitResult(
      2,
      "tsconfig.abc123.json:3:5 - error TS5023: Unknown compiler option 'foo'.",
      ["src/a.ts"],
      "tsconfig.abc123.json",
    ),
    { exitCode: 2, ignoredDependencyErrors: false },
  );
});

test("getDiagnosticExitResult 把非受支持源文件（base.json/JSON module）诊断保守归为全局", () => {
  assert.deepEqual(getDiagnosticExitResult(2, "base.json(2,3): error TS2322: x", ["src/a.ts"]), {
    exitCode: 2,
    ignoredDependencyErrors: false,
  });
  // 依赖错误 + JSON module 类型错误混合：普通 TS 类型错误不能强行放行
  assert.deepEqual(
    getDiagnosticExitResult(2, "dep.ts(1,1): error TS2322: x\ndata.json(2,3): error TS2322: x", [
      "src/a.ts",
    ]),
    { exitCode: 2, ignoredDependencyErrors: false },
  );
});

test("parseGitStatusPorcelain 复制与混合状态只收集一次新路径，并跳过旧路径", () => {
  const output = ["C  new.ts", "old.ts", "RM renamed.ts", "before.ts", " M next.ts", ""].join("\0");
  assert.deepEqual(parseGitStatusPorcelain(output), ["new.ts", "renamed.ts", "next.ts"]);
});

test("filterErrorsInFiles 只保留指定文件的错误，忽略传递依赖的错误", () => {
  const output = [
    "src/changed.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/dep.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join("\n");

  const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(output, ["src/changed.ts"]);
  assert.equal(errorsInSpecifiedFiles.length, 1);
  assert.match(errorsInSpecifiedFiles[0]!, /src\/changed\.ts/);
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

test("filterErrorsInFiles 保留位置诊断路径的前导空白，不被 trim 成别的文件", () => {
  // 文件名本身以空格开头：归属时不能去掉前导空白，否则错误会被当成依赖错误豁免
  assert.equal(
    filterErrorsInFiles(" bad.ts(1,7): error TS2322: x", [" bad.ts"]).errorsInSpecifiedFiles.length,
    1,
  );
  assert.equal(
    filterErrorsInFiles("' bad.vue'(3,7): error TS2322: x", [" bad.vue"]).errorsInSpecifiedFiles
      .length,
    1,
  );
  assert.equal(
    filterErrorsInFiles(" bad.vue:3:7 - error TS2322: x", [" bad.vue"]).errorsInSpecifiedFiles
      .length,
    1,
  );

  // 前导空白不能反过来把别的文件"认领"进来
  const other = filterErrorsInFiles(" bad.ts(1,7): error TS2322: x", ["bad.ts"]);
  assert.deepEqual(other.errorsInSpecifiedFiles, []);
  assert.deepEqual(other.globalErrors, []);
});

test("filterErrorsInFiles 无位置的全局错误仍允许前导缩进", () => {
  const output = "  error TS5083: Cannot read file 'missing.json'.";
  assert.equal(filterErrorsInFiles(output, ["src/a.ts"]).globalErrors.length, 1);
});

test("filterErrorsInFiles 收集无文件位置的全局错误", () => {
  const output = "error TS5083: Cannot read file 'tsconfig.json'.";
  const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(output, ["src/a.ts"]);
  assert.deepEqual(errorsInSpecifiedFiles, []);
  assert.equal(globalErrors.length, 1);
});

test("filterErrorsInFiles 把临时配置与非受支持源文件诊断归为全局", () => {
  const output = [
    "src/a.ts(1,1): error TS2322: x",
    "tsconfig.zzz9.json(3,5): error TS5023: Unknown compiler option 'foo'.",
    "base.json(2,3): error TS2322: y",
    "src/dep.ts(4,5): error TS2322: z",
  ].join("\n");

  const { errorsInSpecifiedFiles, globalErrors } = filterErrorsInFiles(
    output,
    ["src/a.ts"],
    "tsconfig.zzz9.json",
  );
  assert.equal(errorsInSpecifiedFiles.length, 1);
  assert.match(errorsInSpecifiedFiles[0]!, /src\/a\.ts/);
  // 临时配置上的配置诊断与 base.json 上的 TS 错误归全局，依赖的 src/dep.ts 仍被忽略
  assert.equal(globalErrors.length, 2);
  assert.match(globalErrors[0]!, /tsconfig\.zzz9\.json/);
  assert.match(globalErrors[1]!, /base\.json/);
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
  assert.match(errorsInSpecifiedFiles[0]!, /src\/changed\.ts/);
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
  assert.match(stripAnsiCodes(errorsInSpecifiedFiles[0]!), /src\/changed\.ts/);
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

test("createAndSetupTsConfig 按 tsconfig 范围收集 d.ts/.d.mts/.d.cts、尊重用户 skipLibCheck、tmp 配置与原配置同目录", () => {
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
    writeFileSync(join(root, "src", "env.d.mts"), "declare const inScopeMts: number;\n");
    writeFileSync(join(root, "src", "env.d.cts"), "declare const inScopeCts: number;\n");
    writeFileSync(join(root, "stray.d.ts"), "declare const outOfScope: number;\n");
    writeFileSync(join(root, "stray.d.mts"), "declare const outOfScopeMts: number;\n");

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
    // #7：只收集 tsconfig include 范围内的声明文件
    assert.ok(fileNames.some((f: string) => f.endsWith("src/env.d.ts")));
    assert.ok(fileNames.some((f: string) => f.endsWith("src/env.d.mts")));
    assert.ok(fileNames.some((f: string) => f.endsWith("src/env.d.cts")));
    assert.ok(!fileNames.some((f: string) => f.endsWith("stray.d.ts")));
    assert.ok(!fileNames.some((f: string) => f.endsWith("stray.d.mts")));
    // #1：files 统一为绝对路径，tmp 配置与原 tsconfig 同目录
    assert.ok(config.files.every((f: string) => isAbsolute(f)));
    assert.equal(realpathSync(dirname(tmpPath)), realpathSync(root));

    // 与真实编译器解析出的声明文件集合对照（而非手写清单）
    const ts = require("typescript") as typeof import("typescript");
    const parsed = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), undefined, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    })!;
    const compilerDts = parsed.fileNames.filter((name) => /\.d\.[cm]?ts$/i.test(name));
    const collectedDts = (config.files as string[]).filter((f: string) => /\.d\.[cm]?ts$/i.test(f));
    // TS 解析配置时会 realpath 目录（macOS 上 /var → /private/var），两边同样归一化再比
    const normalizePaths = (paths: string[]) =>
      paths.map((f) => realpathSync(f).replace(/\\/g, "/")).sort();
    assert.deepEqual(normalizePaths(collectedDts), normalizePaths(compilerDts));
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

test("createAndSetupTsConfig 尊重 extends 链上游 base 配置里的 skipLibCheck", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-cfg-"));
  const prevCwd = process.cwd();
  let tmpPath: string | undefined;
  try {
    // skipLibCheck:false 写在被 extends 的 base 里，根配置本身不写
    writeFileSync(
      join(root, "base.json"),
      JSON.stringify({ compilerOptions: { skipLibCheck: false } }),
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ extends: "./base.json", compilerOptions: { strict: true } }),
    );

    process.chdir(root);
    try {
      tmpPath = createAndSetupTsConfig(["good.ts"]);
    } finally {
      process.chdir(prevCwd);
    }

    const config = JSON.parse(readFileSync(tmpPath, "utf8"));
    // 不能注入 skipLibCheck:true——tmp 子配置优先级高于 extends 的 base，
    // 注入会静默覆盖用户在 base 里的显式 false；缺省时由 tsc 沿 extends 解析出 false
    assert.equal(config.compilerOptions.skipLibCheck, undefined);
  } finally {
    process.chdir(prevCwd);
    if (tmpPath) rmSync(tmpPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("createAndSetupTsConfig project 传目录时读取其中的 tsconfig.json", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-cfg-"));
  const prevCwd = process.cwd();
  let tmpPath: string | undefined;
  try {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(join(root, "good.ts"), "const a: number = 1;\nexport default a;\n");

    process.chdir(root);
    try {
      tmpPath = createAndSetupTsConfig(["good.ts"], ".");
    } finally {
      process.chdir(prevCwd);
    }

    // tmp 配置创建在解析出的 tsconfig（目录内的）旁边
    const config = JSON.parse(readFileSync(tmpPath, "utf8"));
    assert.ok(config.files.some((f: string) => f.endsWith("good.ts")));
    assert.equal(realpathSync(dirname(tmpPath)), realpathSync(root));
  } finally {
    process.chdir(prevCwd);
    if (tmpPath) rmSync(tmpPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("createAndSetupTsConfig 在有效 incremental/composite 时接管 buildinfo，包括显式缓存路径", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-cfg-"));
  const prevCwd = process.cwd();
  const tmpPaths: string[] = [];
  try {
    const setup = (tsconfig: unknown, forwarded: string[] = []) => {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig));
      process.chdir(root);
      try {
        const tmpPath = createAndSetupTsConfig(["good.ts"], undefined, forwarded);
        tmpPaths.push(tmpPath);
        return tmpPath;
      } finally {
        process.chdir(prevCwd);
      }
    };

    // 配置自身开启 incremental：写入与 tmp 配置同后缀的独占 buildinfo
    const incremental = setup({ compilerOptions: { strict: true, incremental: true } });
    const incrementalBuildInfo = getInternalTsBuildInfoFile(incremental);
    assert.equal(incrementalBuildInfo, incremental.replace(/\.json$/, ".tsbuildinfo"));

    // CLI 转发 --incremental 而配置未开：同样接管
    const forwarded = setup({ compilerOptions: { strict: true } }, ["--incremental"]);
    assert.ok(getInternalTsBuildInfoFile(forwarded));

    // extends 链上游的 composite 同样生效
    writeFileSync(
      join(root, "base.json"),
      JSON.stringify({ compilerOptions: { composite: true } }),
    );
    const composite = setup({ extends: "./base.json" });
    assert.ok(getInternalTsBuildInfoFile(composite));

    // composite:true 不被 incremental:false 屏蔽：配置内显式 false
    const compositeNotShadowed = setup({
      compilerOptions: { composite: true, incremental: false },
    });
    assert.ok(getInternalTsBuildInfoFile(compositeNotShadowed));

    // CLI 显式 --incremental false（tsc 将其解析为 incremental:false）也不屏蔽配置里的 composite
    const cliFalse = setup({ extends: "./base.json" }, ["--incremental", "false"]);
    assert.ok(getInternalTsBuildInfoFile(cliFalse));

    // 无 incremental/composite：不注入缓存选项（避免触发无 incremental 的 TS 错误）
    const plain = setup({ compilerOptions: { strict: true } });
    assert.equal(getInternalTsBuildInfoFile(plain), undefined);

    // 用户显式 --tsBuildInfoFile 同样被内部 override 接管：CLI 末尾追加的同名选项后者覆盖前者
    const explicit = setup({ compilerOptions: { strict: true } }, [
      "--incremental",
      "--tsBuildInfoFile",
      "user.tsbuildinfo",
    ]);
    assert.equal(getInternalTsBuildInfoFile(explicit), explicit.replace(/\.json$/, ".tsbuildinfo"));
  } finally {
    process.chdir(prevCwd);
    for (const p of tmpPaths) rmSync(p, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const SKILL_SOURCE_TEXT = "---\nname: vue-tsc-files\n---\n";
/** U+FEFF，编辑器加的 BOM */
const BOM = String.fromCharCode(0xfeff);

/** 建一份假 skill 源目录，除 SKILL.md 外再放一个附属文件，用来验证整目录复制 */
function createSkillSource(root: string, content = SKILL_SOURCE_TEXT) {
  const source = join(root, "source", "vue-tsc-files");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), content);
  writeFileSync(join(source, "reference.md"), "extra\n");
  return source;
}

/** 建不了符号链接的平台（Windows 缺特权）让对应用例直接跳过，别变成随机失败 */
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

/** 安装目录里不该留下暂存目录/临时文件 */
function hasInstallArtifact(dir: string) {
  return readdirSync(dir).some((name) => name.startsWith(".vue-tsc-files"));
}

test("parseInstallArgs 只在 install 子命令上接管，其余走类型检查流程", () => {
  assert.equal(parseInstallArgs([]), undefined);
  assert.equal(parseInstallArgs(["a.ts"]), undefined);
  assert.equal(parseInstallArgs(["--changed"]), undefined);
  assert.equal(parseInstallArgs(["--staged", "a.ts"]), undefined);
  assert.equal(parseInstallArgs(["--project", "tsconfig.json"]), undefined);
});

test("parseInstallArgs 默认项目级，--user/--global 切用户级", () => {
  assert.deepEqual(parseInstallArgs(["install", "--skill"]), {
    action: "install",
    scope: "project",
    force: false,
  });
  for (const flag of ["--user", "--global"]) {
    assert.deepEqual(parseInstallArgs(["install", "--skill", flag]), {
      action: "install",
      scope: "user",
      force: false,
    });
  }
  assert.deepEqual(parseInstallArgs(["install", "--skill", "--user", "--force"]), {
    action: "install",
    scope: "user",
    force: true,
  });
});

test("parseInstallArgs 处理 help、未知参数与缺少 --skill", () => {
  for (const flag of ["-h", "--help"]) {
    assert.deepEqual(parseInstallArgs(["install", flag]), { action: "help" });
  }
  const unknown = parseInstallArgs(["install", "--skill", "--nope"]);
  assert.equal(unknown?.action, "error");
  assert.match(
    unknown?.action === "error" ? unknown.message : "",
    /Unknown option for install: --nope/,
  );

  const bare = parseInstallArgs(["install"]);
  assert.equal(bare?.action, "error");
  assert.match(bare?.action === "error" ? bare.message : "", /requires --skill/);

  // 少写了 --skill，作用域选项不足以说明要装什么
  const noSkill = parseInstallArgs(["install", "--user"]);
  assert.equal(noSkill?.action, "error");
});

test("getSkillInstallTarget 按作用域选择项目根或用户主目录", () => {
  assert.equal(
    getSkillInstallTarget("project", "/repo", "/home/me"),
    join("/repo", ".agents", "skills", "vue-tsc-files"),
  );
  assert.equal(
    getSkillInstallTarget("user", "/repo", "/home/me"),
    join("/home/me", ".agents", "skills", "vue-tsc-files"),
  );
});

test("installSkill 全新安装复制整个 skill 目录，重跑识别为最新", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");

    const installed = installSkill(source, target, false);
    assert.deepEqual(installed, { status: "installed", targetDir: target });
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
    assert.equal(readFileSync(join(target, "reference.md"), "utf8"), "extra\n");

    assert.deepEqual(installSkill(source, target, false), {
      status: "up-to-date",
      targetDir: target,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 对本地改过的 skill 报冲突，--force 才覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);
    writeFileSync(join(target, "SKILL.md"), "locally edited\n");

    assert.deepEqual(installSkill(source, target, false), {
      status: "conflict",
      targetDir: target,
      reason: "differs",
    });
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "locally edited\n");

    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 目标是普通文件时即使 --force 也不覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "user source file\n");

    for (const force of [false, true]) {
      assert.deepEqual(installSkill(source, target, force), {
        status: "conflict",
        targetDir: target,
        reason: "not-a-directory",
      });
    }
    assert.equal(readFileSync(target, "utf8"), "user source file\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 源目录缺失时抛出可操作的提示", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = join(root, "missing", "vue-tsc-files");
    assert.throws(
      () => installSkill(source, join(root, "target"), true),
      /Bundled skill not found/,
    );
    assert.equal(existsSync(join(root, "target")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 把 CRLF 与 BOM 差异视为同一版本", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);

    // Windows 的 core.autocrlf 或带 BOM 的编辑器改写过的副本，不该被当成需要 --force
    for (const variant of [SKILL_SOURCE_TEXT.replace(/\n/g, "\r\n"), BOM + SKILL_SOURCE_TEXT]) {
      writeFileSync(join(target, "SKILL.md"), variant);
      assert.equal(installSkill(source, target, false).status, "up-to-date");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 目标是悬空符号链接时 --force 只摘链接本身", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  // Windows 上创建悬空链接需要特权；无权限就跳过，别让用例变成 CI 随机失败
  if (!canCreateSymlink(root, join(root, "missing-target"))) return;

  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(root, "missing-target"), target);

    // 悬空链接在 lstat 下现形、stat 下不可见：不能当成"目标不存在"直接拷进去
    assert.deepEqual(installSkill(source, target, false), {
      status: "conflict",
      targetDir: target,
      reason: "dangling-symlink",
    });

    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 覆盖 SKILL.md 上的链接只换目录项，不写穿到别处", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);

    const elsewhere = join(root, "elsewhere.md");
    writeFileSync(elsewhere, "user's own file\n");
    rmSync(join(target, "SKILL.md"));
    symlinkSync(elsewhere, join(target, "SKILL.md"));

    assert.equal(installSkill(source, target, false).status, "conflict");
    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(lstatSync(join(target, "SKILL.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(elsewhere, "utf8"), "user's own file\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 目标是目录 symlink 时保留链接，把内容写进真实目录", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    // dotfiles 用 symlink 管理 skills：链接本身必须留着
    const realDir = join(root, "real-skill");
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(realDir, { recursive: true });
    if (!canCreateSymlink(root, realDir, "dir")) return t.skip("本平台建不了目录符号链接");
    symlinkSync(realDir, target, "dir");
    writeFileSync(join(realDir, "SKILL.md"), "locally edited\n");

    // 链接指向的目录里装着改过的 skill，仍按"内容不同"处理
    assert.deepEqual(installSkill(source, target, false), {
      status: "conflict",
      targetDir: target,
      reason: "differs",
    });

    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(realpathSync(target), realpathSync(realDir));
    assert.equal(readFileSync(join(realDir, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
    assert.equal(readFileSync(join(realDir, "reference.md"), "utf8"), "extra\n");
    assert.equal(hasInstallArtifact(realDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 目录 symlink 内的 SKILL.md 是链接时更新不写穿外部文件", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const realDir = join(root, "real-skill");
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(realDir, { recursive: true });
    if (!canCreateSymlink(root, realDir, "dir")) return t.skip("本平台建不了目录符号链接");

    const elsewhere = join(root, "elsewhere.md");
    writeFileSync(elsewhere, "user's own file\n");
    symlinkSync(realDir, target, "dir");
    symlinkSync(elsewhere, join(realDir, "SKILL.md"));

    assert.equal(installSkill(source, target, false).status, "conflict");
    assert.equal(installSkill(source, target, true).status, "installed");

    // 两层链接都被换成普通目录项，外部文件一个字节都没动
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(lstatSync(join(realDir, "SKILL.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(realDir, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
    assert.equal(readFileSync(elsewhere, "utf8"), "user's own file\n");
    assert.equal(hasInstallArtifact(realDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 覆盖 hardlink 不改外部文件，新装文件也不再共享 inode", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    const elsewhere = join(root, "elsewhere.md");
    writeFileSync(elsewhere, "shared inode\n");
    mkdirSync(target, { recursive: true });
    linkSync(elsewhere, join(target, "SKILL.md"));
    // 原地写入会改到外部文件，测试前先确认二者确实共享同一个 inode
    assert.equal(statSync(join(target, "SKILL.md")).ino, statSync(elsewhere).ino);

    assert.equal(installSkill(source, target, false).status, "conflict");
    assert.equal(installSkill(source, target, true).status, "installed");

    assert.equal(readFileSync(elsewhere, "utf8"), "shared inode\n");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
    assert.notEqual(statSync(join(target, "SKILL.md")).ino, statSync(elsewhere).ino);
    assert.equal(hasInstallArtifact(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 目标 symlink 指向普通文件时 --force 也报 not-a-directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    const elsewhere = join(root, "elsewhere.md");
    writeFileSync(elsewhere, "user source file\n");
    mkdirSync(dirname(target), { recursive: true });
    if (!canCreateSymlink(root, elsewhere)) return t.skip("本平台建不了符号链接");
    symlinkSync(elsewhere, target);

    // 跟着链接写会把用户的源文件改成 skill 内容，风险不对等，--force 也不行
    for (const force of [false, true]) {
      assert.deepEqual(installSkill(source, target, force), {
        status: "conflict",
        targetDir: target,
        reason: "not-a-directory",
      });
    }
    assert.equal(readFileSync(elsewhere, "utf8"), "user source file\n");
    assert.equal(lstatSync(target).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 预检到 SKILL.md 是目录时在动原安装前拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    mkdirSync(join(target, "SKILL.md"), { recursive: true });
    writeFileSync(join(target, "SKILL.md", "keep.md"), "user's own file\n");

    assert.throws(() => installSkill(source, target, true), /is a directory/);
    assert.equal(lstatSync(join(target, "SKILL.md")).isDirectory(), true);
    assert.equal(readFileSync(join(target, "SKILL.md", "keep.md"), "utf8"), "user's own file\n");
    assert.equal(hasInstallArtifact(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 写入失败时原安装与 SKILL.md 的链接形态原样保留", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  // 靠去掉写权限注入失败：root（如容器）与 Windows 上不成立，跳过而不是假装通过
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return t.skip("本平台无法用权限制造写入失败");
  }
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);
    writeFileSync(join(target, "SKILL.md"), "locally edited\n");

    chmodSync(target, 0o500);
    try {
      assert.throws(() => installSkill(source, target, true));
      // 复制没成功就不该有任何提升：旧内容原样在，暂存目录也被清掉
      assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "locally edited\n");
      assert.equal(hasInstallArtifact(target), false);
    } finally {
      chmodSync(target, 0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 更新时保留用户自建文件，附属 payload 照常覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);
    writeFileSync(join(target, "my-notes.md"), "my notes\n");
    writeFileSync(join(target, "SKILL.md"), "locally edited\n");
    // 源侧附属文件有新内容时要跟着更新，不能只搬 SKILL.md
    writeFileSync(join(source, "reference.md"), "extra v2\n");

    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
    assert.equal(readFileSync(join(target, "reference.md"), "utf8"), "extra v2\n");
    assert.equal(readFileSync(join(target, "my-notes.md"), "utf8"), "my notes\n");
    assert.equal(hasInstallArtifact(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 在随包目录里加一份嵌套 payload，返回源目录 */
function addNestedPayload(root: string) {
  const source = createSkillSource(root);
  mkdirSync(join(source, "nested"), { recursive: true });
  writeFileSync(join(source, "nested", "file.md"), "nested payload\n");
  return source;
}

test("installSkill payload 文件撞上目标目录时安装前拒绝，修正后重跑能装全", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = createSkillSource(root, "new skill\n");
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);
    writeFileSync(join(target, "SKILL.md"), "old skill\n");
    rmSync(join(target, "reference.md"));
    mkdirSync(join(target, "reference.md"), { recursive: true });

    // 先提升 SKILL.md 再撞上目录的话，旧 SKILL.md 已被覆盖：重跑会被判成"最新"
    assert.throws(() => installSkill(source, target, true), /is a directory/);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "old skill\n");
    assert.equal(hasInstallArtifact(target), false);

    rmSync(join(target, "reference.md"), { recursive: true });
    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "new skill\n");
    assert.equal(readFileSync(join(target, "reference.md"), "utf8"), "extra\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill payload 目录撞上目标文件时安装前拒绝，旧 SKILL.md 不变", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = addNestedPayload(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);
    writeFileSync(join(target, "SKILL.md"), "old skill\n");
    rmSync(join(target, "nested"), { recursive: true });
    writeFileSync(join(target, "nested"), "not a directory\n");

    assert.throws(() => installSkill(source, target, true), /is not a directory/);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "old skill\n");
    assert.equal(readFileSync(join(target, "nested"), "utf8"), "not a directory\n");
    assert.equal(hasInstallArtifact(target), false);

    rmSync(join(target, "nested"));
    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), SKILL_SOURCE_TEXT);
    assert.equal(readFileSync(join(target, "nested", "file.md"), "utf8"), "nested payload\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 嵌套目标目录是 symlink 时保守拒绝，不写穿到目录外", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = addNestedPayload(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    const outside = join(root, "outside-dir");
    installSkill(source, target, false);
    writeFileSync(join(target, "SKILL.md"), "old skill\n");
    rmSync(join(target, "nested"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "external.md"), "user's own file\n");
    if (!canCreateSymlink(root, outside, "dir")) return t.skip("本平台建不了目录符号链接");
    symlinkSync(outside, join(target, "nested"), "dir");

    assert.throws(() => installSkill(source, target, true), /is not a directory/);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "old skill\n");
    // 外部目录既没被写入 payload，也没被删掉
    assert.deepEqual(readdirSync(outside), ["external.md"]);
    assert.equal(lstatSync(join(target, "nested")).isSymbolicLink(), true);
    assert.equal(hasInstallArtifact(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill 嵌套目录里的文件是 symlink 或 hardlink 时外部文件不变", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  try {
    const source = addNestedPayload(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    installSkill(source, target, false);
    writeFileSync(join(target, "SKILL.md"), "old skill\n");
    rmSync(join(target, "nested"), { recursive: true });
    mkdirSync(join(target, "nested"), { recursive: true });

    const linkedBySymlink = join(root, "by-symlink.md");
    const linkedByHardlink = join(root, "by-hardlink.md");
    writeFileSync(linkedBySymlink, "symlinked\n");
    writeFileSync(linkedByHardlink, "hardlinked\n");
    if (!canCreateSymlink(root, linkedBySymlink)) {
      return t.skip("本平台建不了符号链接");
    }
    symlinkSync(linkedBySymlink, join(target, "nested", "file.md"));
    // 源侧再加一个 second.md，硬链接那一路才也走原子替换
    writeFileSync(join(source, "nested", "second.md"), "second payload\n");
    linkSync(linkedByHardlink, join(target, "nested", "second.md"));
    assert.equal(statSync(join(target, "nested", "second.md")).ino, statSync(linkedByHardlink).ino);

    assert.equal(installSkill(source, target, true).status, "installed");
    assert.equal(readFileSync(join(target, "nested", "file.md"), "utf8"), "nested payload\n");
    assert.equal(readFileSync(join(target, "nested", "second.md"), "utf8"), "second payload\n");
    assert.equal(readFileSync(linkedBySymlink, "utf8"), "symlinked\n");
    assert.equal(readFileSync(linkedByHardlink, "utf8"), "hardlinked\n");
    assert.notEqual(
      statSync(join(target, "nested", "second.md")).ino,
      statSync(linkedByHardlink).ino,
    );
    assert.equal(hasInstallArtifact(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installSkill payload 复制中途失败时旧 SKILL.md 链接与外部文件保持不变", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vtf-skill-"));
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return t.skip("本平台无法用权限制造复制失败");
  }
  try {
    const source = createSkillSource(root);
    const target = join(root, "project", ".agents", "skills", "vue-tsc-files");
    const elsewhere = join(root, "elsewhere.md");
    writeFileSync(elsewhere, "user's own file\n");
    installSkill(source, target, false);
    rmSync(join(target, "SKILL.md"));
    if (!canCreateSymlink(root, elsewhere)) {
      return t.skip("本平台建不了符号链接");
    }
    symlinkSync(elsewhere, join(target, "SKILL.md"));
    // 附属文件读不出来：整份 payload 复制失败，任何提升都不能发生
    chmodSync(join(source, "reference.md"), 0o000);

    assert.throws(() => installSkill(source, target, true));
    assert.equal(lstatSync(join(target, "SKILL.md")).isSymbolicLink(), true);
    assert.equal(readFileSync(elsewhere, "utf8"), "user's own file\n");
    assert.equal(hasInstallArtifact(target), false);
  } finally {
    chmodSync(join(root, "source", "vue-tsc-files", "reference.md"), 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("getPackageVersion 读取包名与版本，文件缺失或内容非法时返回 undefined", () => {
  const root = mkdtempSync(join(tmpdir(), "vtf-version-"));
  try {
    const pkg = join(root, "package.json");
    writeFileSync(pkg, JSON.stringify({ name: "@whiter001/vue-tsc-files", version: "1.2.3" }));
    assert.deepEqual(getPackageVersion(pkg), {
      name: "@whiter001/vue-tsc-files",
      version: "1.2.3",
    });

    // 字段缺失：不能拼出半个版本号
    writeFileSync(pkg, JSON.stringify({ name: "@whiter001/vue-tsc-files" }));
    assert.equal(getPackageVersion(pkg), undefined);

    // 非法 JSON 与文件不存在都不应抛出
    writeFileSync(pkg, "{ not json");
    assert.equal(getPackageVersion(pkg), undefined);
    assert.equal(getPackageVersion(join(root, "missing.json")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatVersion 同时给出包名与版本，读不到时标注 unknown", () => {
  assert.equal(
    formatVersion({ name: "@whiter001/vue-tsc-files", version: "1.2.3" }),
    "vue-tsc-files 1.2.3 (@whiter001/vue-tsc-files)",
  );
  assert.equal(formatVersion(undefined), "vue-tsc-files (unknown version)");
});
