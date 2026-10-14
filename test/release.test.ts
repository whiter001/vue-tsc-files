// 端到端覆盖 scripts/release.mjs 的 --commit 发布链路（issue #21）。
//
// 全流程都在 mkdtemp 出的临时目录里：真实 git + 本地 bare remote（不走网络、
// 不碰 GitHub），npm/pnpm 是 PATH 前置的 stub（Windows .cmd / Unix 可执行脚本），
// 因此既不会触达真实 registry，也不会修改本仓库。

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = fileURLToPath(new URL("../scripts/", import.meta.url));
const BASELINE = "1.0.0";
const BUMPED = "1.0.1";
const PKG = `{
  "name": "release-fixture-pkg",
  "version": "${BASELINE}",
  "private": true,
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
`;
// 4 空格缩进、无结尾换行：用来验证脚本逐字保留用户的手工格式
const PKG_HAND_FORMATTED =
  '{\n    "name": "release-fixture-pkg",\n    "version": "1.0.0",\n    "private": true,\n    "scripts": {\n        "build": "echo hi"\n    }\n}';

// 嵌套的 version 排在顶层之前（overrides 是 package.json 里的真实字段形态），
// 用来验证只改 depth=1 的那个
const PKG_NESTED_SAME_VERSION = `{
  "overrides": {
    "some-dep": {
      "version": "${BASELINE}"
    }
  },
  "name": "release-fixture-pkg",
  "version": "${BASELINE}",
  "private": true
}
`;
const PKG_NESTED_OTHER_VERSION = PKG_NESTED_SAME_VERSION.replace(
  `"version": "${BASELINE}"\n`,
  '"version": "9.9.9"\n',
);

interface Fixture {
  root: string;
  repo: string;
  remote: string;
  calls: string;
  failPublish: string;
  pkgPath: string;
  env: NodeJS.ProcessEnv;
  /** 全部 git 调用都走这里，永远带上隔离 env */
  git: (cwd: string, args: string[]) => { status: number; stdout: string; stderr: string };
  gitOk: (cwd: string, args: string[]) => string;
}

/** 宿主的 GIT_DIR/GIT_INDEX_FILE/GIT_AUTHOR_* 之类会把 git 指到别的仓库或身份 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function writeStubs(bin: string) {
  const windows = process.platform === "win32";
  const npmBody = windows
    ? [
        "@echo off",
        'echo [npm] %*>>"%RELEASE_TEST_CALLS%"',
        'if /i "%~1"=="whoami" echo release-fixture-bot',
        "exit /b 0",
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        'echo "[npm] $*" >> "$RELEASE_TEST_CALLS"',
        'if [ "$1" = "whoami" ]; then echo release-fixture-bot; fi',
        "exit 0",
        "",
      ].join("\n");
  const pnpmBody = windows
    ? [
        "@echo off",
        'echo [pnpm] %*>>"%RELEASE_TEST_CALLS%"',
        'if exist "%RELEASE_TEST_FAIL_PUBLISH%" (',
        "  echo [stub] pnpm publish: simulated failure 1>&2",
        "  exit /b 1",
        ")",
        "exit /b 0",
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        'echo "[pnpm] $*" >> "$RELEASE_TEST_CALLS"',
        'if [ -f "$RELEASE_TEST_FAIL_PUBLISH" ]; then',
        '  echo "[stub] pnpm publish: simulated failure" >&2',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n");
  const npmPath = join(bin, windows ? "npm.cmd" : "npm");
  const pnpmPath = join(bin, windows ? "pnpm.cmd" : "pnpm");
  writeFileSync(npmPath, npmBody);
  writeFileSync(pnpmPath, pnpmBody);
  if (!windows) {
    chmodSync(npmPath, 0o755);
    chmodSync(pnpmPath, 0o755);
  }
}

function createFixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "release-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(remote);
  mkdirSync(bin);
  copyFileSync(join(SCRIPTS_DIR, "release.mjs"), join(repo, "scripts", "release.mjs"));
  copyFileSync(join(SCRIPTS_DIR, "release-args.ts"), join(repo, "scripts", "release-args.ts"));

  const pkgPath = join(repo, "package.json");
  writeFileSync(pkgPath, PKG);
  writeStubs(bin);

  const calls = join(root, "calls.log");
  const failPublish = join(root, "fail-publish");
  const globalConfig = join(root, "global.gitconfig");
  const systemConfig = join(root, "system.gitconfig");
  writeFileSync(calls, "");
  writeFileSync(globalConfig, "");
  writeFileSync(systemConfig, "");

  // 隔离先于第一次 git：config 指向空文件，宿主身份/hooks/gpgsign 都不会进来
  const env: NodeJS.ProcessEnv = {
    ...isolatedEnv(),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    RELEASE_TEST_CALLS: calls,
    RELEASE_TEST_FAIL_PUBLISH: failPublish,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    EMAIL: undefined,
  };

  const git = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
    return {
      status: r.status ?? 1,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
    };
  };
  const gitOk = (cwd: string, args: string[]) => {
    const r = git(cwd, args);
    assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd} failed: ${r.stderr}`);
    return r.stdout;
  };

  gitOk(repo, ["init", "-b", "main"]);
  gitOk(repo, ["config", "user.name", "release fixture"]);
  gitOk(repo, ["config", "user.email", "fixture@example.invalid"]);
  gitOk(repo, ["add", "-A"]);
  gitOk(repo, ["commit", "-m", `baseline ${BASELINE}`]);
  gitOk(remote, ["init", "--bare", "-b", "main"]);
  gitOk(repo, ["remote", "add", "origin", remote]);
  gitOk(repo, ["push", "-u", "origin", "main"]);

  return { root, repo, remote, calls, failPublish, pkgPath, env, git, gitOk };
}

function release(fx: Fixture, args: string[]) {
  const r = spawnSync(process.execPath, [join(fx.repo, "scripts", "release.mjs"), ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    env: fx.env,
    timeout: 120_000,
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const callsOf = (fx: Fixture) => readFileSync(fx.calls, "utf8").trim();
const versionOf = (path: string) => JSON.parse(readFileSync(path, "utf8")).version;
const indexVersion = (fx: Fixture) =>
  JSON.parse(fx.gitOk(fx.repo, ["show", ":package.json"])).version;
const remoteVersion = (fx: Fixture) =>
  JSON.parse(fx.gitOk(fx.remote, ["show", "main:package.json"])).version;

test("--commit 遇到已有暂存内容时拒绝：不发布也不动用户的文件（#21）", (t) => {
  const fx = createFixture(t);
  writeFileSync(join(fx.repo, "wip.txt"), "user work in progress\n");
  fx.gitOk(fx.repo, ["add", "wip.txt"]);
  const headBefore = fx.gitOk(fx.repo, ["rev-parse", "HEAD"]);

  const dry = release(fx, ["patch", "--commit", "--dry-run"]);
  assert.notEqual(dry.status, 0);
  assert.match(dry.out, /staged changes/);
  assert.match(dry.out, /wip\.txt/);
  assert.equal(callsOf(fx), "", "dry-run 不该调用 npm/pnpm");

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /staged changes/);
  assert.match(r.out, /wip\.txt/);
  assert.doesNotMatch(r.out, /Published/);
  assert.equal(callsOf(fx), "", "拒绝发生在 whoami/publish 之前");
  assert.equal(readFileSync(fx.pkgPath, "utf8"), PKG);
  assert.equal(fx.gitOk(fx.repo, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(fx.gitOk(fx.repo, ["tag", "--list"]), "");
  assert.equal(fx.gitOk(fx.repo, ["diff", "--cached", "--name-only"]), "wip.txt");
  assert.match(fx.gitOk(fx.remote, ["log", "-1", "--format=%s"]), /^baseline /);
});

test("--commit 发布成功：只提交 package.json，annotated tag 与分支一起推上远端", (t) => {
  const fx = createFixture(t);
  writeFileSync(join(fx.repo, "scratch.md"), "unstaged notes\n");

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.match(callsOf(fx), /\[npm\] whoami/);
  assert.match(callsOf(fx), /\[pnpm\] publish --no-git-checks/);

  assert.equal(versionOf(fx.pkgPath), BUMPED);
  assert.equal(indexVersion(fx), BUMPED);
  assert.equal(fx.gitOk(fx.repo, ["log", "-1", "--format=%s"]), `chore: bump version to ${BUMPED}`);
  assert.equal(fx.gitOk(fx.repo, ["show", "--name-only", "--format=", "HEAD"]), "package.json");
  assert.match(fx.gitOk(fx.repo, ["status", "--porcelain"]), /\?\? scratch\.md/);

  // annotated 而不是 lightweight tag，且远端同时拿到分支与 tag
  assert.equal(fx.gitOk(fx.repo, ["cat-file", "-t", `refs/tags/v${BUMPED}`]), "tag");
  assert.equal(fx.gitOk(fx.remote, ["cat-file", "-t", `refs/tags/v${BUMPED}`]), "tag");
  assert.equal(
    fx.gitOk(fx.remote, ["tag", "-l", "--format=%(contents:subject)", `v${BUMPED}`]),
    `v${BUMPED}`,
  );
  assert.equal(
    fx.gitOk(fx.remote, ["rev-parse", "main"]),
    fx.gitOk(fx.repo, ["rev-parse", "HEAD"]),
  );
  assert.equal(remoteVersion(fx), BUMPED);
  assert.equal(fx.gitOk(fx.remote, ["show", "--name-only", "--format=", "main"]), "package.json");
});

test("发布失败：逐字还原 package.json，且不动索引", (t) => {
  const fx = createFixture(t);
  writeFileSync(fx.pkgPath, PKG_HAND_FORMATTED);
  writeFileSync(fx.failPublish, "");

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Restored package\.json/);
  assert.equal(readFileSync(fx.pkgPath, "utf8"), PKG_HAND_FORMATTED);
  assert.equal(indexVersion(fx), BASELINE);
  assert.equal(fx.gitOk(fx.repo, ["tag", "--list"]), "");
  assert.equal(fx.gitOk(fx.repo, ["rev-list", "--count", "HEAD"]), "1");
});

test("版本改写只替换 version 字段，保留用户的手工格式", (t) => {
  const fx = createFixture(t);
  writeFileSync(fx.pkgPath, PKG_HAND_FORMATTED);

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(fx.pkgPath, "utf8"), PKG_HAND_FORMATTED.replace(BASELINE, BUMPED));
});

test("嵌套 version 排在顶层之前时只改顶层（#21 review：正则会误改嵌套字段）", (t) => {
  for (const nested of [PKG_NESTED_SAME_VERSION, PKG_NESTED_OTHER_VERSION]) {
    const fx = createFixture(t);
    const nestedVersion = JSON.parse(nested).overrides["some-dep"].version as string;
    writeFileSync(fx.pkgPath, nested);

    const r = release(fx, ["patch", "--commit", "--yes"]);
    assert.equal(r.status, 0, r.out);

    const expected = nested.replace(`\n  "version": "${BASELINE}",`, `\n  "version": "${BUMPED}",`);
    assert.equal(readFileSync(fx.pkgPath, "utf8"), expected);
    const parsed = JSON.parse(readFileSync(fx.pkgPath, "utf8"));
    assert.equal(parsed.version, BUMPED, "顶层版本必须被改掉");
    assert.equal(parsed.overrides["some-dep"].version, nestedVersion, "嵌套版本必须原样保留");
    assert.equal(remoteVersion(fx), BUMPED);
  }
});

test("commit 失败（pre-commit hook）时保留新版本，索引与工作区保持一致", (t) => {
  const fx = createFixture(t);
  const hook = join(fx.repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, '#!/bin/sh\necho "pre-commit: refusing" >&2\nexit 1\n');
  chmodSync(hook, 0o755);

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(callsOf(fx), /\[pnpm\] publish --no-git-checks/, "发布已经发生，不能回退版本");
  assert.equal(versionOf(fx.pkgPath), BUMPED);
  assert.equal(indexVersion(fx), BUMPED);
  assert.equal(fx.gitOk(fx.repo, ["diff", "--name-only"]), "", "工作区与索引不应再出现 MM 差异");
  assert.equal(fx.gitOk(fx.repo, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(fx.gitOk(fx.repo, ["tag", "--list"]), "");
  assert.match(r.out, /is already on npm/);
  assert.match(r.out, /git commit -m "chore: bump version to 1\.0\.1"/);
});

test("push 失败：保留本地提交、tag 与新版本，并打印剩余命令", (t) => {
  const fx = createFixture(t);
  fx.gitOk(fx.repo, ["remote", "set-url", "origin", join(fx.root, "missing-remote.git")]);

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.equal(versionOf(fx.pkgPath), BUMPED);
  assert.equal(fx.gitOk(fx.repo, ["log", "-1", "--format=%s"]), `chore: bump version to ${BUMPED}`);
  assert.equal(fx.gitOk(fx.repo, ["cat-file", "-t", `refs/tags/v${BUMPED}`]), "tag");
  assert.equal(fx.gitOk(fx.repo, ["status", "--porcelain"]), "");
  assert.match(r.out, /is already on npm/);
  assert.match(r.out, /git push --atomic origin HEAD refs\/tags\/v1\.0\.1/);
  assert.equal(fx.gitOk(fx.remote, ["tag", "--list"]), "");
  assert.match(fx.gitOk(fx.remote, ["log", "-1", "--format=%s"]), /^baseline /);
});

test("same-version --commit：提交手工改好的版本号并 tag + push", (t) => {
  const fx = createFixture(t);
  writeFileSync(fx.pkgPath, readFileSync(fx.pkgPath, "utf8").replace(BASELINE, "1.1.0"));

  const r = release(fx, ["1.1.0", "--commit", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /version unchanged, skipping bump/);
  assert.match(callsOf(fx), /\[pnpm\] publish --no-git-checks/);
  assert.equal(fx.gitOk(fx.repo, ["log", "-1", "--format=%s"]), "chore: bump version to 1.1.0");
  assert.equal(fx.gitOk(fx.repo, ["show", "--name-only", "--format=", "HEAD"]), "package.json");
  assert.equal(fx.gitOk(fx.remote, ["cat-file", "-t", "refs/tags/v1.1.0"]), "tag");
  assert.equal(remoteVersion(fx), "1.1.0");
});

test("same-version --commit 且 package.json 无变化：跳过空提交但仍 tag + push", (t) => {
  const fx = createFixture(t);

  const r = release(fx, [BASELINE, "--commit", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /skipping the empty version-bump commit/);
  assert.equal(
    fx.gitOk(fx.repo, ["rev-list", "--count", "HEAD"]),
    "1",
    "不该为了 tag 造一个空提交",
  );
  assert.equal(fx.gitOk(fx.repo, ["cat-file", "-t", `refs/tags/v${BASELINE}`]), "tag");
  assert.equal(fx.gitOk(fx.remote, ["cat-file", "-t", `refs/tags/v${BASELINE}`]), "tag");
  assert.equal(fx.gitOk(fx.remote, ["rev-list", "--count", "main"]), "1");
  assert.equal(fx.gitOk(fx.repo, ["status", "--porcelain"]), "");
});

test("dry-run：无任何副作用，且完全不依赖 npm 身份", (t) => {
  const fx = createFixture(t);

  const r = release(fx, ["patch", "--commit", "--dry-run", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(callsOf(fx), "", "npm stub 从未被调用，因此与登录态无关");
  assert.match(r.out, /git push --atomic origin HEAD refs\/tags\/v1\.0\.1/);
  assert.match(r.out, /No changes made/);
  assert.equal(readFileSync(fx.pkgPath, "utf8"), PKG);
  assert.equal(fx.gitOk(fx.repo, ["status", "--porcelain"]), "");
  assert.equal(fx.gitOk(fx.repo, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(fx.gitOk(fx.repo, ["tag", "--list"]), "");
  assert.equal(fx.gitOk(fx.remote, ["for-each-ref", "--format=%(refname)"]), "refs/heads/main");
  assert.match(fx.gitOk(fx.remote, ["log", "-1", "--format=%s"]), /^baseline /);
});

test("dry-run 不回显 origin URL 里的 userinfo 凭据", (t) => {
  const fx = createFixture(t);
  // git.invalid 是保留域名，不会解析；这里只验证输出，绝不会真的 push
  fx.gitOk(fx.repo, [
    "remote",
    "set-url",
    "origin",
    "https://release-bot:ghp_dummy_pat_0123456789abcdef@git.invalid/example/vue-tsc-files.git",
  ]);

  const r = release(fx, ["patch", "--commit", "--dry-run", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /origin configured/);
  assert.doesNotMatch(r.out, /ghp_dummy_pat_0123456789abcdef/);
  assert.doesNotMatch(r.out, /release-bot/);
  assert.equal(callsOf(fx), "");
});

test("atomic push：远端拒收 tag 时分支也不推进", (t) => {
  const fx = createFixture(t);
  const hook = join(fx.remote, "hooks", "update");
  writeFileSync(
    hook,
    `#!/bin/sh\nif [ "$1" = "refs/tags/v${BUMPED}" ]; then\n  echo "update hook: refusing $1" >&2\n  exit 1\nfi\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
  const remoteBefore = fx.gitOk(fx.remote, ["rev-parse", "main"]);

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /update hook: refusing refs\/tags\/v1\.0\.1/);
  // 本地提交与 tag 保留，等用户手动收尾
  assert.equal(fx.gitOk(fx.repo, ["log", "-1", "--format=%s"]), `chore: bump version to ${BUMPED}`);
  assert.equal(fx.gitOk(fx.repo, ["cat-file", "-t", `refs/tags/v${BUMPED}`]), "tag");
  // --atomic：tag 被拒则分支也不能推上去，否则远端会出现有提交没 tag 的状态
  assert.equal(fx.gitOk(fx.remote, ["rev-parse", "main"]), remoteBefore);
  assert.equal(fx.gitOk(fx.remote, ["rev-list", "--count", "main"]), "1");
  assert.equal(fx.gitOk(fx.remote, ["tag", "--list"]), "");
  assert.equal(fx.gitOk(fx.repo, ["rev-parse", "origin/main"]), remoteBefore);
});

test("前置检查：目标 tag 已存在时在发布前拒绝", (t) => {
  const fx = createFixture(t);
  fx.gitOk(fx.repo, ["tag", "-a", `v${BUMPED}`, "-m", "already taken"]);

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Tag v1\.0\.1 already exists/);
  assert.equal(callsOf(fx), "");
  assert.equal(readFileSync(fx.pkgPath, "utf8"), PKG);
});

test("前置检查：缺少 git 提交身份时在发布前拒绝", (t) => {
  const fx = createFixture(t);
  fx.gitOk(fx.repo, ["config", "--unset", "user.name"]);
  fx.gitOk(fx.repo, ["config", "--unset", "user.email"]);

  const r = release(fx, ["patch", "--commit", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /needs a git identity/);
  assert.equal(callsOf(fx), "");
  assert.equal(readFileSync(fx.pkgPath, "utf8"), PKG);
});

test("不带 --commit：完全不碰 git，发布失败仍还原版本", (t) => {
  const fx = createFixture(t);
  writeFileSync(fx.failPublish, "");

  const r = release(fx, ["patch", "--yes"]);
  assert.notEqual(r.status, 0);
  assert.match(callsOf(fx), /\[pnpm\] publish --no-git-checks/);
  assert.equal(readFileSync(fx.pkgPath, "utf8"), PKG);
  assert.equal(fx.gitOk(fx.repo, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(fx.gitOk(fx.repo, ["tag", "--list"]), "");
});
