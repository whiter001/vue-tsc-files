// Pure parsing/version logic for scripts/release.mjs, kept side-effect free
// so tests can import it without triggering a release.

export const RELEASE_USAGE = `Usage: node scripts/release.mjs [major|minor|patch|x.y.z] [options]

Options:
  --dry-run   Print the plan (version bump, publish, git steps) without touching anything
  --commit    After a successful publish, commit package.json, tag and push
  --yes       Skip the confirmation prompt before publishing
  -h, --help  Show this help

Examples:
  node scripts/release.mjs              # patch bump of the current version
  node scripts/release.mjs 1.4.0        # publish an explicit version
  node scripts/release.mjs minor --commit --dry-run`;

export interface ReleasePlan {
  /** major | minor | patch | x.y.z */
  target: string;
  shouldCommit: boolean;
  dryRun: boolean;
  assumeYes: boolean;
}

export type ParsedReleaseArgs =
  | { kind: "help" }
  | { kind: "plan"; plan: ReleasePlan }
  | { kind: "error"; message: string };

// semver 规范禁止前导零；01.02.3 这类版本 npm publish 会直接拒收，
// 与其白走一轮发布-失败-回滚，不如在解析阶段就拦下
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMANTIC_TARGETS = new Set(["major", "minor", "patch"]);

export function parseReleaseArgs(argv: string[]): ParsedReleaseArgs {
  const plan: ReleasePlan = {
    target: "patch",
    shouldCommit: false,
    dryRun: false,
    assumeYes: false,
  };
  const positionals: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    switch (arg) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--commit":
        plan.shouldCommit = true;
        break;
      case "--dry-run":
        plan.dryRun = true;
        break;
      case "--yes":
        plan.assumeYes = true;
        break;
      default:
        return { kind: "error", message: `Unknown option: ${arg}` };
    }
  }

  if (positionals.length > 1) {
    return {
      kind: "error",
      message: `Expected at most one version target, got: ${positionals.join(" ")}`,
    };
  }

  const [target] = positionals;
  if (target !== undefined && !SEMANTIC_TARGETS.has(target) && !VERSION_RE.test(target)) {
    return {
      kind: "error",
      message: `Invalid version target: ${target}. Use major|minor|patch|<x.y.z>.`,
    };
  }
  if (target !== undefined) plan.target = target;

  return { kind: "plan", plan };
}

export function bumpVersion(current: string, target: string): string {
  if (VERSION_RE.test(target)) return target;
  const [maj, min, pat] = splitSemver(current);
  if (target === "major") return `${maj + 1}.0.0`;
  if (target === "minor") return `${maj}.${min + 1}.0`;
  if (target === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Invalid version: ${target}. Use major|minor|patch|<x.y.z>.`);
}

/** package.json 的 version 由工具链保证是合法 semver，解析失败直接抛错而不是产出 NaN */
function splitSemver(current: string): [number, number, number] {
  const parts = current.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`Current version is not valid semver: ${current}`);
  }
  const [maj, min, pat] = parts.map((p) => Number.parseInt(p, 10));
  return [maj ?? 0, min ?? 0, pat ?? 0];
}
