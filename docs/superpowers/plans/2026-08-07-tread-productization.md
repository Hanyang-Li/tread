# tread 产品化重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 tread 从「包装三家 agent 的 skill/plugin 安装」重构成「conda 式环境容器 + 只读检视器」，激活靠 shell 环境变量、零 shim，并提供 TUI 浏览界面。

**Architecture:** 单一 agent 适配器表把隔离机制塌缩成「设一个环境变量」。tread 不再写任何 agent 的 skill/plugin/mcp/hooks，只做四类只读解析用于展示。输出分两条严格隔离的通路：机读命令走裸 stdout，人读命令走渲染层（纯文本或 opentui TUI）。

**Tech Stack:** Bun ≥ 1.3、TypeScript、`@opentui/react` + React 19（TUI）、`bun:test`。产物为 `bun build --compile` 单二进制，无运行时外部依赖。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-07-tread-productization-design.md`，所有行为以其为准。
- 只读原则：tread **绝不写入**任何 agent 的 skill / plugin / mcp / hooks 配置。唯一允许写入的是环境骨架（目录、kimi 的 `config.toml`、两条凭证 symlink）与 `state.json`。
- 机读边界：`init` / `_export` / `path` / `exec` 四条命令的输出必须裸 `process.stdout.write`，不得经过任何渲染层、不得着色。
- 密钥：MCP 的 header 与 env 的**值**一律以 `••••` 呈现，只显示 key。任何输出通路都不得例外。
- 范围：只读环境级（全局）内容。claude `installed_plugins.json` 中 `scope !== "user"` 的条目一律跳过。
- 环境变量：`TREAD_STATE_DIR` 覆盖状态目录（测试用）。不再有 `TREAD_SHARE_DIR`。
- 退出码：`0` 成功，`1` 任何错误。错误信息格式为 `tread: <what>` + 缩进上下文 + 缩进下一步。
- 颜色：`NO_COLOR` 存在或 `!process.stdout.isTTY` 时全部关闭。
- agent 目录名固定：claude=`.claude`，cursor=`.cursor`，kimi=`.kimi-code`；kimi 的 skill 落点为环境根下的 `.agents/skills`。

---

### Task 1: 基础层 — agent 适配器表与路径

**Files:**
- Create: `src/agents.ts`
- Rewrite: `src/paths.ts`
- Test: `test/agents.test.ts`, `test/paths.test.ts`
- Delete: `src/skill.ts`, `src/inspect.ts`, `src/plugin/` (整个目录)

**Interfaces:**
- Produces:
  - `AGENTS: readonly ["claude","cursor","kimi"]`, `type Agent`
  - `AGENT_SPECS: Record<Agent, AgentSpec>`，`AgentSpec = { bin: string; dir: string; envVars(absDir: string): Record<string,string> }`
  - `isAgent(s: string): s is Agent`
  - `stateDir(): string`、`envsDir(): string`、`envDir(name: string): string`
  - `agentDir(envRoot: string, a: Agent): string`
  - `skillsDir(envRoot: string, a: Agent): string`
  - `validateEnvName(name: string): void`
  - `activationEnv(envRoot: string): Record<string,string>` — 六个 export 的键值

- [ ] **Step 1: 写失败测试 `test/agents.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { AGENTS, AGENT_SPECS, isAgent } from "../src/agents.ts";

describe("agent table", () => {
  test("three agents, stable order", () => {
    expect(AGENTS).toEqual(["claude", "cursor", "kimi"]);
  });

  test("isAgent", () => {
    expect(isAgent("claude")).toBe(true);
    expect(isAgent("vim")).toBe(false);
  });

  test("每个 agent 的隔离变量指向自己的子目录", () => {
    expect(AGENT_SPECS.claude.envVars("/e/.claude")).toEqual({
      CLAUDE_CONFIG_DIR: "/e/.claude",
    });
    expect(AGENT_SPECS.cursor.envVars("/e/.cursor")).toEqual({
      CURSOR_CONFIG_DIR: "/e/.cursor",
      CURSOR_DATA_DIR: "/e/.cursor",
    });
    expect(AGENT_SPECS.kimi.envVars("/e/.kimi-code")).toEqual({
      KIMI_CODE_HOME: "/e/.kimi-code",
    });
  });

  test("目录名与 bin 名", () => {
    expect(AGENT_SPECS.claude.dir).toBe(".claude");
    expect(AGENT_SPECS.cursor.dir).toBe(".cursor");
    expect(AGENT_SPECS.kimi.dir).toBe(".kimi-code");
    expect(AGENT_SPECS.cursor.bin).toBe("cursor-agent");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test test/agents.test.ts`
Expected: FAIL — `Cannot find module '../src/agents.ts'`

- [ ] **Step 3: 实现 `src/agents.ts`**

```ts
export const AGENTS = ["claude", "cursor", "kimi"] as const;
export type Agent = (typeof AGENTS)[number];

export interface AgentSpec {
  /** executable name on PATH */
  bin: string;
  /** config directory, relative to the env root */
  dir: string;
  /** isolation variables, given the absolute config dir */
  envVars(absDir: string): Record<string, string>;
}

export const AGENT_SPECS: Record<Agent, AgentSpec> = {
  claude: {
    bin: "claude",
    dir: ".claude",
    envVars: (d) => ({ CLAUDE_CONFIG_DIR: d }),
  },
  cursor: {
    bin: "cursor-agent",
    dir: ".cursor",
    // cursor splits config and data; point both at one dir, mirroring ~/.cursor
    envVars: (d) => ({ CURSOR_CONFIG_DIR: d, CURSOR_DATA_DIR: d }),
  },
  kimi: {
    bin: "kimi",
    dir: ".kimi-code",
    envVars: (d) => ({ KIMI_CODE_HOME: d }),
  },
};

export function isAgent(s: string): s is Agent {
  return (AGENTS as readonly string[]).includes(s);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test test/agents.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 写失败测试 `test/paths.test.ts`**

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

beforeAll(() => { process.env.TREAD_STATE_DIR = "/tmp/tread-paths-test"; });

const p = await import("../src/paths.ts");

describe("paths", () => {
  test("envDir 在 envs/ 之下", () => {
    expect(p.envDir("work")).toBe("/tmp/tread-paths-test/envs/work");
  });

  test("validateEnvName 拒绝路径穿越与空值", () => {
    expect(() => p.validateEnvName("demo-1.x")).not.toThrow();
    expect(() => p.validateEnvName("../evil")).toThrow();
    expect(() => p.validateEnvName("a/b")).toThrow();
    expect(() => p.validateEnvName("")).toThrow();
  });

  test("agentDir", () => {
    expect(p.agentDir("/e", "kimi")).toBe("/e/.kimi-code");
  });

  test("kimi 的 skills 落在环境根的 .agents/skills，其余在各自 config dir 下", () => {
    expect(p.skillsDir("/e", "kimi")).toBe("/e/.agents/skills");
    expect(p.skillsDir("/e", "claude")).toBe("/e/.claude/skills");
    expect(p.skillsDir("/e", "cursor")).toBe("/e/.cursor/skills");
  });

  test("activationEnv 给出全部六个变量", () => {
    const e = p.activationEnv("/e/work");
    expect(e.TREAD_ENV_DIR).toBe("/e/work");
    expect(e.CLAUDE_CONFIG_DIR).toBe("/e/work/.claude");
    expect(e.CURSOR_CONFIG_DIR).toBe("/e/work/.cursor");
    expect(e.CURSOR_DATA_DIR).toBe("/e/work/.cursor");
    expect(e.KIMI_CODE_HOME).toBe("/e/work/.kimi-code");
  });
});
```

- [ ] **Step 6: 运行确认失败，然后重写 `src/paths.ts`**

Run: `bun test test/paths.test.ts` → FAIL

```ts
import os from "node:os";
import path from "node:path";
import { AGENT_SPECS, AGENTS, type Agent } from "./agents.ts";

export const realHome = os.homedir();

export function stateDir(): string {
  return process.env.TREAD_STATE_DIR ?? path.join(realHome, ".local/state/tread");
}
export function envsDir(): string {
  return path.join(stateDir(), "envs");
}
export function stateFile(): string {
  return path.join(stateDir(), "state.json");
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateEnvName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid name "${name}"\n\n  use letters, digits, dot, dash, underscore`,
    );
  }
}

export function envDir(name: string): string {
  validateEnvName(name);
  return path.join(envsDir(), name);
}

export function agentDir(envRoot: string, a: Agent): string {
  return path.join(envRoot, AGENT_SPECS[a].dir);
}

/**
 * Where the `skills` CLI lands a global install when HOME=<envRoot>.
 * claude/cursor resolve under their own config dir; kimi resolves to
 * ~/.agents/skills, which we bridge via config.toml's extra_skill_dirs.
 */
export function skillsDir(envRoot: string, a: Agent): string {
  return a === "kimi"
    ? path.join(envRoot, ".agents/skills")
    : path.join(agentDir(envRoot, a), "skills");
}

/** The variables `tread use` exports into the caller's shell. */
export function activationEnv(envRoot: string): Record<string, string> {
  const out: Record<string, string> = { TREAD_ENV_DIR: envRoot };
  for (const a of AGENTS) Object.assign(out, AGENT_SPECS[a].envVars(agentDir(envRoot, a)));
  return out;
}
```

- [ ] **Step 7: 删除被取代的旧模块并确认全绿**

```bash
rm -rf src/plugin src/skill.ts src/inspect.ts test/plugin.test.ts test/env.test.ts
bun test
```

Expected: PASS，无遗留失败

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: agent adapter table + path layer, drop plugin/skill wrappers"
```

---

### Task 2: 环境生命周期

**Files:**
- Rewrite: `src/env.ts`
- Test: `test/env.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `envDir` / `agentDir` / `skillsDir` / `AGENTS`
- Produces:
  - `createEnv(name: string): string` — 返回环境根路径
  - `ensureSkeleton(envRoot: string): void` — 幂等
  - `listEnvs(): string[]` — 排序
  - `removeEnv(name: string): void`
  - `requireEnv(name: string): string`
  - `resolveEnv(name?: string): string` — 无参时取 `$TREAD_ENV`，都没有则抛
  - `touchLastUsed(name: string): void`、`lastUsed(): Record<string,string>`

- [ ] **Step 1: 写失败测试 `test/env.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-env-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_ENV;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { createEnv, ensureSkeleton, listEnvs, removeEnv, requireEnv, resolveEnv,
        touchLastUsed, lastUsed } = await import("../src/env.ts");
const { envDir, skillsDir, agentDir } = await import("../src/paths.ts");

describe("env lifecycle", () => {
  test("create 建出三个 agent 骨架", () => {
    const dir = createEnv("work");
    expect(dir).toBe(envDir("work"));
    for (const a of ["claude", "cursor", "kimi"] as const) {
      expect(fs.existsSync(agentDir(dir, a))).toBe(true);
    }
    expect(fs.existsSync(skillsDir(dir, "kimi"))).toBe(true);
  });

  test("kimi 骨架含 extra_skill_dirs 桥接", () => {
    const dir = envDir("work");
    const toml = fs.readFileSync(path.join(dir, ".kimi-code/config.toml"), "utf8");
    expect(toml).toContain(`extra_skill_dirs = ["${skillsDir(dir, "kimi")}"]`);
  });

  test("kimi 凭证 symlink 指回真 home", () => {
    const dir = envDir("work");
    for (const n of ["credentials", "oauth"]) {
      const p = path.join(dir, ".kimi-code", n);
      expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(p)).toBe(path.join(os.homedir(), ".kimi-code", n));
    }
  });

  test("重复 create 报错", () => {
    expect(() => createEnv("work")).toThrow(/already exists/);
  });

  test("ensureSkeleton 幂等且自愈", () => {
    const dir = envDir("work");
    fs.rmSync(agentDir(dir, "cursor"), { recursive: true, force: true });
    ensureSkeleton(dir);
    expect(fs.existsSync(agentDir(dir, "cursor"))).toBe(true);
    expect(() => ensureSkeleton(dir)).not.toThrow();
  });

  test("ensureSkeleton 不覆盖已存在的 config.toml", () => {
    const dir = envDir("work");
    const f = path.join(dir, ".kimi-code/config.toml");
    fs.writeFileSync(f, 'default_model = "x"\n');
    ensureSkeleton(dir);
    expect(fs.readFileSync(f, "utf8")).toBe('default_model = "x"\n');
  });

  test("list / require / remove", () => {
    createEnv("alpha");
    expect(listEnvs()).toEqual(["alpha", "work"]);
    expect(requireEnv("work")).toBe(envDir("work"));
    expect(() => requireEnv("nope")).toThrow(/no environment named/);
    removeEnv("alpha");
    expect(listEnvs()).toEqual(["work"]);
  });

  test("resolveEnv 回落到 TREAD_ENV", () => {
    process.env.TREAD_ENV = "work";
    expect(resolveEnv()).toBe(envDir("work"));
    delete process.env.TREAD_ENV;
    expect(() => resolveEnv()).toThrow(/no environment active/);
  });

  test("lastUsed 持久化", () => {
    touchLastUsed("work");
    expect(typeof lastUsed().work).toBe("string");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test test/env.test.ts` → FAIL

- [ ] **Step 3: 实现 `src/env.ts`**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, type Agent } from "./agents.ts";
import { agentDir, envDir, envsDir, skillsDir, stateFile, validateEnvName } from "./paths.ts";

/** Create every agent's config dir plus kimi's bridge and credential links. Idempotent. */
export function ensureSkeleton(envRoot: string): void {
  for (const a of AGENTS) fs.mkdirSync(agentDir(envRoot, a), { recursive: true });
  fs.mkdirSync(skillsDir(envRoot, "kimi"), { recursive: true });

  // kimi does not follow ~/.agents/skills when KIMI_CODE_HOME is redirected.
  const toml = path.join(agentDir(envRoot, "kimi"), "config.toml");
  if (!fs.existsSync(toml)) {
    fs.writeFileSync(toml, `extra_skill_dirs = ["${skillsDir(envRoot, "kimi")}"]\n`);
  }

  // kimi keeps credentials on disk; share them with the real home so a new
  // environment does not require logging in again.
  for (const n of ["credentials", "oauth"]) {
    const link = path.join(agentDir(envRoot, "kimi"), n);
    const target = path.join(os.homedir(), ".kimi-code", n);
    if (!fs.existsSync(link) && !isLink(link)) fs.symlinkSync(target, link);
  }
}

function isLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function createEnv(name: string): string {
  const dir = envDir(name);
  if (fs.existsSync(dir)) {
    throw new Error(`"${name}" already exists\n\n  ${dir}\n  tread use ${name}   to activate it`);
  }
  fs.mkdirSync(dir, { recursive: true });
  ensureSkeleton(dir);
  return dir;
}

export function listEnvs(): string[] {
  const base = envsDir();
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function requireEnv(name: string): string {
  const dir = envDir(name);
  if (!fs.existsSync(dir)) {
    const hint = suggest(name);
    throw new Error(
      `no environment named "${name}"\n` +
      (hint ? `\n  did you mean "${hint}"?\n  tread ls   to see all` : `\n  tread ls   to see all`),
    );
  }
  return dir;
}

export function resolveEnv(name?: string): string {
  if (name) return requireEnv(name);
  const active = process.env.TREAD_ENV;
  if (active) return requireEnv(active);
  throw new Error("no environment active\n\n  tread ls           list environments\n  tread use <name>   activate one");
}

export function removeEnv(name: string): void {
  fs.rmSync(requireEnv(name), { recursive: true, force: true });
  const s = readState();
  delete s.lastUsed[name];
  writeState(s);
}

interface State { lastUsed: Record<string, string> }

function readState(): State {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return { lastUsed: j?.lastUsed ?? {} };
  } catch { return { lastUsed: {} }; }
}

function writeState(s: State): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2) + "\n");
}

export function lastUsed(): Record<string, string> { return readState().lastUsed; }

export function touchLastUsed(name: string): void {
  const s = readState();
  s.lastUsed[name] = new Date().toISOString();
  writeState(s);
}

/** Levenshtein-lite: closest name within edit distance 2, else null. */
function suggest(name: string): string | null {
  let best: string | null = null, bestD = 3;
  for (const e of listEnvs()) {
    const d = distance(name, e);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test test/env.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: environment lifecycle with idempotent skeleton"
```

---

### Task 3: shell 集成

**Files:**
- Create: `src/shell.ts`
- Test: `test/shell.test.ts`

**Interfaces:**
- Consumes: `activationEnv`、`resolveEnv`、`touchLastUsed`
- Produces:
  - `initSnippet(target: "zsh"|"bash"|"fish"|"starship"): string`
  - `exportLines(name: string): string` — `tread _export use <name>`
  - `deactivateLines(): string`
  - `shellLoaded(): boolean` — 依据 `TREAD_SHELL`

- [ ] **Step 1: 写失败测试 `test/shell.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-shell-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { createEnv } = await import("../src/env.ts");
const { initSnippet, exportLines, deactivateLines, shellLoaded } = await import("../src/shell.ts");

describe("shell integration", () => {
  test("zsh 片段定义 tread() 且只让 ls 走 --emit", () => {
    const s = initSnippet("zsh");
    expect(s).toContain("tread()");
    expect(s).toContain("--emit");
    expect(s).toContain("TREAD_SHELL=zsh");
    // show 是只读的，不得进入 --emit 分支
    expect(s).not.toMatch(/ls\|show\)/);
  });

  test("fish 用 function 而非 POSIX 语法", () => {
    const s = initSnippet("fish");
    expect(s).toContain("function tread");
    expect(s).not.toContain("case \"$1\" in");
  });

  test("starship 片段是 TOML 且引用 env_var.tread", () => {
    const s = initSnippet("starship");
    expect(s).toContain("[env_var.tread]");
    expect(s).toContain("variable = 'TREAD_ENV'");
    expect(s).toContain("${env_var.tread}");
  });

  test("exportLines 导出六个变量加 TREAD_ENV", () => {
    createEnv("work");
    const out = exportLines("work");
    for (const k of ["TREAD_ENV", "TREAD_ENV_DIR", "CLAUDE_CONFIG_DIR",
                     "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "KIMI_CODE_HOME"]) {
      expect(out).toContain(`export ${k}=`);
    }
    expect(out).toContain("TREAD_ENV='work'");
  });

  test("路径中的单引号被转义", () => {
    createEnv("qu.ote");
    expect(() => exportLines("qu.ote")).not.toThrow();
  });

  test("deactivateLines unset 全部", () => {
    const out = deactivateLines();
    expect(out).toContain("unset TREAD_ENV");
    expect(out).toContain("unset KIMI_CODE_HOME");
  });

  test("shellLoaded 依据 TREAD_SHELL", () => {
    delete process.env.TREAD_SHELL;
    expect(shellLoaded()).toBe(false);
    process.env.TREAD_SHELL = "zsh";
    expect(shellLoaded()).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test test/shell.test.ts` → FAIL

- [ ] **Step 3: 实现 `src/shell.ts`**

```ts
import { activationEnv } from "./paths.ts";
import { requireEnv, touchLastUsed } from "./env.ts";

const POSIX = (shell: string) => `# tread shell integration — eval "$(tread init ${shell})"
tread() {
  case "$1" in
    use|deactivate)
      eval "$(command tread _export "$@")" ;;
    ls)
      local __f; __f=$(mktemp -t tread) || return 1
      command tread ls "\${@:2}" --emit "$__f"; local __c=$?
      [ -s "$__f" ] && eval "$(cat "$__f")"
      rm -f "$__f"; return $__c ;;
    *) command tread "$@" ;;
  esac
}
export TREAD_SHELL=${shell}
`;

const FISH = `# tread shell integration — tread init fish | source
function tread
  switch $argv[1]
    case use deactivate
      command tread _export $argv | source
    case ls
      set -l __f (mktemp -t tread)
      command tread ls $argv[2..] --emit $__f
      set -l __c $status
      if test -s $__f; source $__f; end
      rm -f $__f
      return $__c
    case '*'
      command tread $argv
  end
end
set -gx TREAD_SHELL fish
`;

const STARSHIP = `# add to ~/.config/starship.toml
[env_var.tread]
variable = 'TREAD_ENV'
format   = '[  $env_value ]($style)'
style    = 'bold fg:255 bg:99'
disabled = false

# then place \${env_var.tread} in your top-level format, e.g.
# format = '\${env_var.tread}$directory$git_branch$character'
`;

export function initSnippet(target: string): string {
  switch (target) {
    case "zsh": case "bash": return POSIX(target);
    case "fish": return FISH;
    case "starship": return STARSHIP;
    default:
      throw new Error(`unknown shell "${target}"\n\n  supported: zsh, bash, fish, starship`);
  }
}

/** Single-quote for POSIX and fish alike. */
function q(v: string): string { return `'${v.replaceAll("'", `'\\''`)}'`; }

export function exportLines(name: string): string {
  const dir = requireEnv(name);
  touchLastUsed(name);
  const vars = { TREAD_ENV: name, ...activationEnv(dir) };
  const isFish = process.env.TREAD_SHELL === "fish";
  return Object.entries(vars)
    .map(([k, v]) => (isFish ? `set -gx ${k} ${q(v)}` : `export ${k}=${q(v)}`))
    .join("\n") + "\n";
}

export function deactivateLines(): string {
  const keys = ["TREAD_ENV", ...Object.keys(activationEnv("/"))];
  const isFish = process.env.TREAD_SHELL === "fish";
  return keys.map((k) => (isFish ? `set -e ${k}` : `unset ${k}`)).join("\n") + "\n";
}

export function shellLoaded(): boolean {
  return Boolean(process.env.TREAD_SHELL);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test test/shell.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: shell integration for zsh/bash/fish + starship snippet"
```

---

### Task 4: 只读解析层 — 类型与 skills / mcp

**Files:**
- Create: `src/inspect/types.ts`, `src/inspect/skills.ts`, `src/inspect/mcp.ts`
- Test: `test/inspect/skills.test.ts`, `test/inspect/mcp.test.ts`

**Interfaces:**
- Produces:
  - `SkillInfo`, `PluginInfo`, `McpServerInfo`, `HookInfo`, `Inventory`（下方定义，Task 5/6 依赖）
  - `readSkills(envRoot: string, a: Agent): SkillInfo[]`
  - `readMcp(envRoot: string, a: Agent): McpServerInfo[]`
  - `MASK = "••••"`

- [ ] **Step 1: 定义 `src/inspect/types.ts`**（无测试，纯类型）

```ts
export const MASK = "••••";

export interface SkillInfo {
  name: string;
  version: string | null;
  description: string | null;
  /** short, human-facing origin: "open.feishu.cn" | "vercel-labs/agent-skills" | "plugin" */
  source: string | null;
  sourceUrl: string | null;
  path: string;
  installedAt: string | null;
  requiresBins: string[];
}

export interface PluginInfo {
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  marketplace: string | null;
  marketplaceSource: string | null;
  commit: string | null;
  installedAt: string | null;
  updatedAt: string | null;
  path: string | null;
  enabled: boolean;
}

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  headerKeys: string[];
  envKeys: string[];
  source: string;
}

export interface HookInfo {
  event: string;
  /** merged: identical commands under one event collapse into one entry */
  matchers: string[];
  command: string;
  timeout: number | null;
  source: string;
  /** how many raw entries this row represents */
  count: number;
}

export interface Inventory {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcp: McpServerInfo[];
  hooks: HookInfo[];
  /** false when the agent dir holds nothing but tread's own skeleton */
  used: boolean;
}
```

- [ ] **Step 2: 写失败测试 `test/inspect/skills.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-skills-"));
  const d = path.join(env, ".claude/skills/lark-mail");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"),
`---
name: lark-mail
version: 1.0.0
description: "飞书邮箱：写邮件、查邮件"
metadata:
  requires:
    bins: ["lark-cli"]
---
body
`);
  const bare = path.join(env, ".claude/skills/bare");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "SKILL.md"), "no frontmatter here\n");
  fs.mkdirSync(path.join(env, ".claude/skills/empty"), { recursive: true });
  fs.mkdirSync(path.join(env, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(env, ".agents/.skill-lock.json"), JSON.stringify({
    version: 1,
    skills: {
      "lark-mail": {
        source: "open.feishu.cn", sourceType: "well-known",
        sourceUrl: "https://open.feishu.cn/.well-known/skills/lark-mail/SKILL.md",
        installedAt: "2026-06-26T10:04:15.422Z",
      },
    },
  }));
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readSkills } = await import("../../src/inspect/skills.ts");

describe("readSkills", () => {
  test("解析 frontmatter 并合并 lock 信息", () => {
    const s = readSkills(env, "claude").find((x) => x.name === "lark-mail")!;
    expect(s.version).toBe("1.0.0");
    expect(s.description).toContain("飞书邮箱");
    expect(s.requiresBins).toEqual(["lark-cli"]);
    expect(s.source).toBe("open.feishu.cn");
    expect(s.installedAt).toBe("2026-06-26T10:04:15.422Z");
  });

  test("没有 frontmatter 的 skill 用目录名兜底，不抛异常", () => {
    const s = readSkills(env, "claude").find((x) => x.name === "bare")!;
    expect(s).toBeDefined();
    expect(s.version).toBeNull();
    expect(s.description).toBeNull();
  });

  test("没有 SKILL.md 的目录被忽略", () => {
    expect(readSkills(env, "claude").some((x) => x.name === "empty")).toBe(false);
  });

  test("目录不存在时返回空数组", () => {
    expect(readSkills("/nonexistent", "kimi")).toEqual([]);
  });

  test("按名字排序", () => {
    expect(readSkills(env, "claude").map((s) => s.name)).toEqual(["bare", "lark-mail"]);
  });
});
```

- [ ] **Step 3: 实现 `src/inspect/skills.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { skillsDir } from "../paths.ts";
import type { SkillInfo } from "./types.ts";

interface LockEntry { source?: string; sourceType?: string; sourceUrl?: string; installedAt?: string }

function readLock(envRoot: string): Record<string, LockEntry> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(envRoot, ".agents/.skill-lock.json"), "utf8"));
    return j?.skills ?? {};
  } catch { return {}; }
}

/** Minimal YAML frontmatter reader: scalars, quoted strings, and the one
 *  nested list we care about (metadata.requires.bins). */
export function parseFrontmatter(text: string): Record<string, any> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const body = text.slice(text.indexOf("\n") + 1, end);
  const out: Record<string, any> = {};
  let inRequires = false;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const bins = line.match(/^\s+bins:\s*\[(.*)\]\s*$/);
    if (inRequires && bins) {
      out.requiresBins = bins[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      continue;
    }
    if (/^\s+requires:\s*$/.test(line)) { inRequires = true; continue; }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    inRequires = false;
    const [, k, v] = kv;
    if (v === "") continue;
    out[k] = v.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function readSkills(envRoot: string, a: Agent): SkillInfo[] {
  const base = skillsDir(envRoot, a);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const lock = readLock(envRoot);
  const out: SkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = path.join(base, e.name);
    const md = path.join(dir, "SKILL.md");
    let text: string;
    try { text = fs.readFileSync(md, "utf8"); } catch { continue; }
    const fm = parseFrontmatter(text);
    const l = lock[e.name] ?? {};
    out.push({
      name: fm.name ?? e.name,
      version: fm.version ?? null,
      description: fm.description ?? null,
      source: l.source ?? null,
      sourceUrl: l.sourceUrl ?? null,
      path: dir,
      installedAt: l.installedAt ?? null,
      requiresBins: fm.requiresBins ?? [],
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test test/inspect/skills.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 写失败测试 `test/inspect/mcp.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-mcp-"));
  fs.mkdirSync(path.join(env, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(env, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(env, ".kimi-code"), { recursive: true });
  fs.writeFileSync(path.join(env, ".claude/.mcp.json"), JSON.stringify({
    mcpServers: { local: { command: "/bin/echo", args: ["hi"], env: { TOKEN: "secret" } } },
  }));
  fs.writeFileSync(path.join(env, ".claude/.claude.json"), JSON.stringify({
    mcpServers: { extra: { command: "/bin/true" } },
  }));
  fs.writeFileSync(path.join(env, ".cursor/mcp.json"), JSON.stringify({
    mcpServers: { remote: { url: "https://x/mcp", headers: { "X-API-Key": "sk-real-secret" } } },
  }));
  fs.writeFileSync(path.join(env, ".kimi-code/mcp.json"), "{ not json");
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readMcp } = await import("../../src/inspect/mcp.ts");

describe("readMcp", () => {
  test("stdio 服务器解析 command/args，只留 env 的 key", () => {
    const s = readMcp(env, "claude").find((x) => x.name === "local")!;
    expect(s.transport).toBe("stdio");
    expect(s.command).toBe("/bin/echo");
    expect(s.args).toEqual(["hi"]);
    expect(s.envKeys).toEqual(["TOKEN"]);
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  test("claude 合并 .mcp.json 与 .claude.json", () => {
    expect(readMcp(env, "claude").map((s) => s.name)).toEqual(["extra", "local"]);
  });

  test("http 服务器只留 header 的 key，绝不含明文值", () => {
    const s = readMcp(env, "cursor")[0];
    expect(s.transport).toBe("http");
    expect(s.url).toBe("https://x/mcp");
    expect(s.headerKeys).toEqual(["X-API-Key"]);
    expect(JSON.stringify(s)).not.toContain("sk-real-secret");
  });

  test("坏 JSON 不抛异常，返回空", () => {
    expect(readMcp(env, "kimi")).toEqual([]);
  });
});
```

- [ ] **Step 6: 实现 `src/inspect/mcp.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { agentDir } from "../paths.ts";
import type { McpServerInfo } from "./types.ts";

/** Config files holding `mcpServers`, per agent, relative to its config dir. */
function sources(a: Agent): string[] {
  return a === "claude" ? [".mcp.json", ".claude.json"] : ["mcp.json"];
}

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function readMcp(envRoot: string, a: Agent): McpServerInfo[] {
  const byName = new Map<string, McpServerInfo>();
  for (const rel of sources(a)) {
    const file = path.join(agentDir(envRoot, a), rel);
    const servers = readJson(file)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, s] of Object.entries<any>(servers)) {
      byName.set(name, {
        name,
        transport: s?.url ? "http" : "stdio",
        command: s?.command ?? null,
        args: Array.isArray(s?.args) ? s.args.map(String) : [],
        url: s?.url ?? null,
        headerKeys: Object.keys(s?.headers ?? {}),
        envKeys: Object.keys(s?.env ?? {}),
        source: rel,
      });
    }
  }
  return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
}
```

- [ ] **Step 7: 运行确认通过并提交**

```bash
bun test test/inspect/
git add -A && git commit -m "feat: read-only skills and mcp parsers with secret masking"
```

---

### Task 5: 只读解析层 — plugins / hooks / inventory

**Files:**
- Create: `src/inspect/plugins.ts`, `src/inspect/hooks.ts`, `src/inspect/index.ts`
- Test: `test/inspect/plugins.test.ts`, `test/inspect/hooks.test.ts`

**Interfaces:**
- Consumes: Task 4 的类型与 `readSkills` / `readMcp`
- Produces:
  - `readPlugins(envRoot: string, a: Agent): PluginInfo[]`
  - `readHooks(envRoot: string, a: Agent): HookInfo[]`
  - `inventory(envRoot: string, a: Agent): Inventory`

- [ ] **Step 1: 写失败测试 `test/inspect/plugins.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-plugins-"));
  const pd = path.join(env, ".claude/plugins");
  fs.mkdirSync(path.join(pd, "cache/official/feature-dev/1.4.0/.claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(pd, "cache/official/feature-dev/1.4.0/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "feature-dev", description: "Feature workflow", author: { name: "Anthropic" } }));
  fs.writeFileSync(path.join(pd, "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "feature-dev@official": [{
        scope: "user", version: "1.4.0", gitCommitSha: "909649d1234",
        installPath: path.join(pd, "cache/official/feature-dev/1.4.0"),
        installedAt: "2026-04-11T03:46:05.098Z", lastUpdated: "2026-08-06T07:50:32.960Z",
      }],
      "scoped@official": [{
        scope: "project", version: "1.0.0",
        projectPath: "/some/project", installPath: "/x",
        installedAt: "2026-01-01T00:00:00.000Z",
      }],
    },
  }));
  fs.writeFileSync(path.join(pd, "known_marketplaces.json"), JSON.stringify({
    official: { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
  }));

  const kd = path.join(env, ".kimi-code/plugins");
  fs.mkdirSync(kd, { recursive: true });
  fs.writeFileSync(path.join(kd, "installed.json"), JSON.stringify({
    version: 1,
    plugins: [{ id: "my-tool", root: "/r", source: "github", enabled: true,
                installedAt: "2026-07-15T00:00:00.000Z", originalSource: "github.com/me/my-tool" }],
  }));
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readPlugins } = await import("../../src/inspect/plugins.ts");

describe("readPlugins", () => {
  test("claude: 读版本/sha/时间，并从 manifest 补 description", () => {
    const p = readPlugins(env, "claude");
    expect(p).toHaveLength(1);
    expect(p[0].name).toBe("feature-dev");
    expect(p[0].version).toBe("1.4.0");
    expect(p[0].commit).toBe("909649d");
    expect(p[0].description).toBe("Feature workflow");
    expect(p[0].author).toBe("Anthropic");
    expect(p[0].marketplace).toBe("official");
    expect(p[0].marketplaceSource).toBe("github:anthropics/claude-plugins-official");
  });

  test("project scope 一律跳过", () => {
    expect(readPlugins(env, "claude").some((p) => p.name === "scoped")).toBe(false);
  });

  test("kimi: 读 installed.json", () => {
    const p = readPlugins(env, "kimi");
    expect(p).toHaveLength(1);
    expect(p[0].name).toBe("my-tool");
    expect(p[0].enabled).toBe(true);
    expect(p[0].marketplaceSource).toBe("github.com/me/my-tool");
  });

  test("cursor: 无插件目录时返回空", () => {
    expect(readPlugins(env, "cursor")).toEqual([]);
  });
});
```

- [ ] **Step 2: 实现 `src/inspect/plugins.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { agentDir } from "../paths.ts";
import type { PluginInfo } from "./types.ts";

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function claudePlugins(cfg: string): PluginInfo[] {
  const installed = readJson(path.join(cfg, "plugins/installed_plugins.json"));
  const markets = readJson(path.join(cfg, "plugins/known_marketplaces.json")) ?? {};
  const out: PluginInfo[] = [];
  for (const [key, list] of Object.entries<any>(installed?.plugins ?? {})) {
    const [name, marketplace = null] = key.split("@");
    for (const rec of Array.isArray(list) ? list : []) {
      if (rec?.scope !== "user") continue;          // environment-level only
      const manifest = readJson(path.join(rec.installPath ?? "", ".claude-plugin/plugin.json"));
      const src = markets[marketplace as string]?.source;
      out.push({
        name,
        version: rec.version && rec.version !== "unknown" ? rec.version : null,
        description: manifest?.description ?? null,
        author: manifest?.author?.name ?? manifest?.author ?? null,
        marketplace,
        marketplaceSource: src?.repo ? `${src.source}:${src.repo}` : null,
        commit: rec.gitCommitSha ? String(rec.gitCommitSha).slice(0, 7) : null,
        installedAt: rec.installedAt ?? null,
        updatedAt: rec.lastUpdated ?? null,
        path: rec.installPath ?? null,
        enabled: true,
      });
    }
  }
  return out;
}

function kimiPlugins(cfg: string): PluginInfo[] {
  const data = readJson(path.join(cfg, "plugins/installed.json"));
  return (Array.isArray(data?.plugins) ? data.plugins : []).map((p: any) => ({
    name: p.id ?? "?",
    version: p.version ?? null,
    description: null,
    author: null,
    marketplace: null,
    marketplaceSource: p.originalSource ?? p.source ?? null,
    commit: p.github?.installedSha ? String(p.github.installedSha).slice(0, 7) : null,
    installedAt: p.installedAt ?? null,
    updatedAt: p.updatedAt ?? null,
    path: p.root ?? null,
    enabled: p.enabled !== false,
  }));
}

function cursorPlugins(cfg: string): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const sub of ["plugins/local", "plugins/cache"]) {
    const base = path.join(cfg, sub);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      out.push({
        name: e.name, version: null, description: null, author: null,
        marketplace: sub.endsWith("cache") ? "cache" : "local",
        marketplaceSource: null, commit: null,
        installedAt: null, updatedAt: null,
        path: path.join(base, e.name), enabled: true,
      });
    }
  }
  return out;
}

export function readPlugins(envRoot: string, a: Agent): PluginInfo[] {
  const cfg = agentDir(envRoot, a);
  const out = a === "claude" ? claudePlugins(cfg)
            : a === "kimi"   ? kimiPlugins(cfg)
            :                  cursorPlugins(cfg);
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
```

- [ ] **Step 3: 写失败测试 `test/inspect/hooks.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-hooks-"));
  fs.mkdirSync(path.join(env, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(env, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(env, ".kimi-code"), { recursive: true });
  fs.writeFileSync(path.join(env, ".claude/settings.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Grep|Glob", hooks: [{ type: "command", command: "gate.sh", timeout: 5 }] }],
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: "remind.sh" }] },
        { matcher: "resume",  hooks: [{ type: "command", command: "remind.sh" }] },
        { matcher: "clear",   hooks: [{ type: "command", command: "remind.sh" }] },
        { matcher: "*",       hooks: [{ type: "command", command: "state.sh", timeout: 10 }] },
      ],
    },
  }));
  fs.writeFileSync(path.join(env, ".cursor/hooks.json"), JSON.stringify({
    hooks: { afterAgentResponse: [{ command: "bridge --source cursor" }] },
  }));
  fs.writeFileSync(path.join(env, ".kimi-code/config.toml"),
`default_model = "k3"

[[hooks]]
event = "SessionStart"
command = "state.sh session"
timeout = 10
`);
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readHooks } = await import("../../src/inspect/hooks.ts");

describe("readHooks", () => {
  test("claude: 同 event 同命令的 matcher 合并成一行，count 记真实条数", () => {
    const h = readHooks(env, "claude");
    const merged = h.find((x) => x.command === "remind.sh")!;
    expect(merged.event).toBe("SessionStart");
    expect(merged.matchers).toEqual(["startup", "resume", "clear"]);
    expect(merged.count).toBe(3);
  });

  test("claude: 不同命令不合并，timeout 保留", () => {
    const h = readHooks(env, "claude");
    expect(h).toHaveLength(3);
    expect(h.find((x) => x.command === "gate.sh")!.timeout).toBe(5);
    expect(h.find((x) => x.command === "state.sh")!.matchers).toEqual(["*"]);
  });

  test("cursor: 扁平结构，无 matcher", () => {
    const h = readHooks(env, "cursor");
    expect(h).toHaveLength(1);
    expect(h[0].event).toBe("afterAgentResponse");
    expect(h[0].command).toBe("bridge --source cursor");
    expect(h[0].matchers).toEqual([]);
  });

  test("kimi: TOML [[hooks]]", () => {
    const h = readHooks(env, "kimi");
    expect(h).toHaveLength(1);
    expect(h[0].event).toBe("SessionStart");
    expect(h[0].timeout).toBe(10);
  });

  test("文件缺失或损坏返回空", () => {
    expect(readHooks("/nonexistent", "claude")).toEqual([]);
  });
});
```

- [ ] **Step 4: 实现 `src/inspect/hooks.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { agentDir } from "../paths.ts";
import type { HookInfo } from "./types.ts";

interface Raw { event: string; matcher: string | null; command: string; timeout: number | null }

function hookFile(a: Agent): string {
  return a === "claude" ? "settings.json" : a === "cursor" ? "hooks.json" : "config.toml";
}

function readRaw(envRoot: string, a: Agent): Raw[] {
  const file = path.join(agentDir(envRoot, a), hookFile(a));
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }

  if (a === "kimi") {
    let cfg: any;
    try { cfg = Bun.TOML.parse(text); } catch { return []; }
    return (Array.isArray(cfg?.hooks) ? cfg.hooks : []).map((h: any) => ({
      event: String(h?.event ?? "?"),
      matcher: h?.matcher ?? null,
      command: String(h?.command ?? "?"),
      timeout: typeof h?.timeout === "number" ? h.timeout : null,
    }));
  }

  let json: any;
  try { json = JSON.parse(text); } catch { return []; }
  const out: Raw[] = [];
  for (const [event, groups] of Object.entries<any>(json?.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      // claude nests handlers under `hooks`; cursor puts the command inline
      const handlers = Array.isArray(g?.hooks) ? g.hooks : [g];
      for (const h of handlers) {
        if (!h?.command) continue;
        out.push({
          event,
          matcher: g?.matcher ?? null,
          command: String(h.command),
          timeout: typeof h.timeout === "number" ? h.timeout : null,
        });
      }
    }
  }
  return out;
}

/** Collapse identical commands under one event into a single row. */
export function mergeHooks(raw: Raw[], source: string): HookInfo[] {
  const byKey = new Map<string, HookInfo>();
  for (const r of raw) {
    const key = `${r.event} ${r.command}`;
    const existing = byKey.get(key);
    if (existing) {
      if (r.matcher && !existing.matchers.includes(r.matcher)) existing.matchers.push(r.matcher);
      existing.count += 1;
      if (existing.timeout === null) existing.timeout = r.timeout;
      continue;
    }
    byKey.set(key, {
      event: r.event,
      matchers: r.matcher ? [r.matcher] : [],
      command: r.command,
      timeout: r.timeout,
      source,
      count: 1,
    });
  }
  return [...byKey.values()];
}

export function readHooks(envRoot: string, a: Agent): HookInfo[] {
  return mergeHooks(readRaw(envRoot, a), hookFile(a));
}
```

- [ ] **Step 5: 实现 `src/inspect/index.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { agentDir } from "../paths.ts";
import { readSkills } from "./skills.ts";
import { readPlugins } from "./plugins.ts";
import { readMcp } from "./mcp.ts";
import { readHooks } from "./hooks.ts";
import type { Inventory } from "./types.ts";

/** Entries tread itself writes when creating the skeleton. */
const SKELETON = new Set(["config.toml", "credentials", "oauth"]);

function hasBeenUsed(envRoot: string, a: Agent): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(agentDir(envRoot, a)); } catch { return false; }
  return entries.some((e) => !SKELETON.has(e));
}

export function inventory(envRoot: string, a: Agent): Inventory {
  return {
    skills: readSkills(envRoot, a),
    plugins: readPlugins(envRoot, a),
    mcp: readMcp(envRoot, a),
    hooks: readHooks(envRoot, a),
    used: hasBeenUsed(envRoot, a),
  };
}

export * from "./types.ts";
export { readSkills, readPlugins, readMcp, readHooks };
```

- [ ] **Step 6: 运行全部解析测试并提交**

```bash
bun test test/inspect/
git add -A && git commit -m "feat: plugin and hook parsers, inventory aggregation"
```

---

### Task 6: 纯文本渲染层

**Files:**
- Create: `src/render.ts`
- Test: `test/render.test.ts`

**Interfaces:**
- Produces:
  - `color(on: boolean)` → `{ dim, red, green, yellow, bold, inverse }`，每个是 `(s: string) => string`
  - `colorsEnabled(): boolean`
  - `table(rows: string[][], opts?: { gap?: number }): string[]` — 按列宽对齐，宽字符按显示宽度计
  - `displayWidth(s: string): number` — CJK 与 emoji 记 2
  - `truncateMiddle(s: string, max: number): string`
  - `formatError(message: string): string`
  - `relTime(iso: string | null, now?: Date): string` — `"2 minutes ago"` / `"3 days"` / `"never"`

- [ ] **Step 1: 写失败测试 `test/render.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
const { table, displayWidth, truncateMiddle, relTime, color } = await import("../src/render.ts");

describe("displayWidth", () => {
  test("CJK 记两格", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("飞书")).toBe(4);
    expect(displayWidth("a飞b")).toBe(4);
  });
  test("忽略 ANSI 转义", () => {
    expect(displayWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });
});

describe("table", () => {
  test("按显示宽度对齐", () => {
    const rows = table([["a", "1"], ["bbb", "2"]]);
    expect(rows[0]).toBe("a    1");
    expect(rows[1]).toBe("bbb  2");
  });
  test("含 CJK 时仍对齐", () => {
    const rows = table([["飞书", "1"], ["ab", "2"]]);
    expect(displayWidth(rows[0])).toBe(displayWidth(rows[1]));
  });
  test("末列不补空格", () => {
    expect(table([["a", "1"]])[0].endsWith("1")).toBe(true);
  });
});

describe("truncateMiddle", () => {
  test("超长时中间省略，保留尾部", () => {
    const r = truncateMiddle("/Users/me/.local/state/tread/envs/work", 20);
    expect(displayWidth(r)).toBeLessThanOrEqual(20);
    expect(r).toContain("…");
    expect(r.endsWith("work")).toBe(true);
  });
  test("不超长时原样返回", () => {
    expect(truncateMiddle("short", 20)).toBe("short");
  });
});

describe("relTime", () => {
  const now = new Date("2026-08-07T12:00:00Z");
  test("分钟/天/从未", () => {
    expect(relTime("2026-08-07T11:58:00Z", now)).toBe("2 minutes ago");
    expect(relTime("2026-08-04T12:00:00Z", now)).toBe("3 days");
    expect(relTime(null, now)).toBe("never");
  });
  test("一分钟内", () => {
    expect(relTime("2026-08-07T11:59:50Z", now)).toBe("just now");
  });
});

describe("color", () => {
  test("关闭时是恒等函数", () => {
    const c = color(false);
    expect(c.red("x")).toBe("x");
  });
  test("开启时包裹 ANSI", () => {
    expect(color(true).red("x")).toContain("\x1b[");
  });
});
```

- [ ] **Step 2: 实现 `src/render.ts`**

```ts
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Wide (CJK / fullwidth / emoji) code points count as two columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)));
}

export function table(rows: string[][], opts: { gap?: number } = {}): string[] {
  const gap = opts.gap ?? 2;
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) {
    widths[i] = Math.max(0, ...rows.map((r) => displayWidth(r[i] ?? "")));
  }
  return rows.map((r) =>
    r.map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i] + gap))).join(""),
  );
}

export function truncateMiddle(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  if (max <= 1) return "…";
  const keepTail = Math.floor((max - 1) * 0.6);
  const keepHead = max - 1 - keepTail;
  const chars = [...s];
  let head = "", tail = "";
  for (const ch of chars) { if (displayWidth(head + ch) > keepHead) break; head += ch; }
  for (let i = chars.length - 1; i >= 0; i--) {
    if (displayWidth(chars[i] + tail) > keepTail) break;
    tail = chars[i] + tail;
  }
  return head + "…" + tail;
}

export function relTime(iso: string | null, now = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const s = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const id = (s: string) => s;

export function color(on: boolean) {
  return on
    ? { dim: wrap("2"), red: wrap("31"), green: wrap("32"),
        yellow: wrap("33"), bold: wrap("1"), inverse: wrap("7") }
    : { dim: id, red: id, green: id, yellow: id, bold: id, inverse: id };
}

export function colorsEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function formatError(message: string): string {
  return `tread: ${message}`;
}
```

- [ ] **Step 3: 运行确认通过并提交**

```bash
bun test test/render.test.ts
git add -A && git commit -m "feat: plain-text render helpers with wide-char aware alignment"
```

---

### Task 7: MCP 探测

**Files:**
- Create: `src/probe.ts`
- Test: `test/probe.test.ts`

**Interfaces:**
- Consumes: `McpServerInfo`
- Produces:
  - `type ProbeResult = { state: "ok"; tools: string[]; latencyMs: number } | { state: "error"; reason: string } | { state: "unchecked" }`
  - `cheapCheck(s: McpServerInfo): Promise<ProbeResult>` — stdio 只查可执行性；http 不发请求，返回 `unchecked`
  - `fullProbe(s: McpServerInfo, timeoutMs?: number): Promise<ProbeResult>` — 完整 initialize + tools/list

- [ ] **Step 1: 写失败测试 `test/probe.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { McpServerInfo } from "../src/inspect/types.ts";
const { cheapCheck, fullProbe } = await import("../src/probe.ts");

const stdio = (command: string): McpServerInfo => ({
  name: "s", transport: "stdio", command, args: [],
  url: null, headerKeys: [], envKeys: [], source: "x",
});

describe("cheapCheck", () => {
  test("stdio: 命令不存在", async () => {
    const r = await cheapCheck(stdio("/definitely/not/here"));
    expect(r.state).toBe("error");
    expect((r as any).reason).toContain("not found");
  });

  test("stdio: 存在且可执行", async () => {
    expect((await cheapCheck(stdio("/bin/echo"))).state).toBe("ok");
  });

  test("stdio: PATH 上的裸命令名也能解析", async () => {
    expect((await cheapCheck(stdio("echo"))).state).toBe("ok");
  });

  test("http: 不做网络请求，返回 unchecked", async () => {
    const r = await cheapCheck({ ...stdio(""), transport: "http", url: "https://x" });
    expect(r.state).toBe("unchecked");
  });
});

describe("fullProbe", () => {
  test("stdio: 不说 MCP 协议的进程在超时内被判失败且不挂起", async () => {
    const r = await fullProbe(stdio("/bin/cat"), 300);
    expect(r.state).toBe("error");
  }, 5000);

  test("stdio: 命令不存在直接失败", async () => {
    expect((await fullProbe(stdio("/definitely/not/here"), 300)).state).toBe("error");
  });
});
```

- [ ] **Step 2: 实现 `src/probe.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import type { McpServerInfo } from "./inspect/types.ts";

export type ProbeResult =
  | { state: "ok"; tools: string[]; latencyMs: number }
  | { state: "error"; reason: string }
  | { state: "unchecked" };

function resolveBin(command: string): string | null {
  if (command.includes("/")) return fs.existsSync(command) ? command : null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, command);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function executable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * Free, side-effect-free check. A stdio MCP server has no steady-state
 * "connection" to observe — it is spawned by the agent per session — so the
 * only honest cheap signal is whether its command exists and can run.
 */
export async function cheapCheck(s: McpServerInfo): Promise<ProbeResult> {
  if (s.transport === "http") return { state: "unchecked" };
  if (!s.command) return { state: "error", reason: "no command" };
  const bin = resolveBin(s.command);
  if (!bin) return { state: "error", reason: `not found: ${s.command}` };
  if (!executable(bin)) return { state: "error", reason: `not executable: ${s.command}` };
  return { state: "ok", tools: [], latencyMs: 0 };
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tread", version: "0.2.0" },
  },
};
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

export async function fullProbe(s: McpServerInfo, timeoutMs = 3000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const tools = s.transport === "http"
      ? await probeHttp(s, timeoutMs)
      : await probeStdio(s, timeoutMs);
    return { state: "ok", tools, latencyMs: Date.now() - started };
  } catch (e) {
    return { state: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function probeHttp(s: McpServerInfo, timeoutMs: number): Promise<string[]> {
  // headers are read from the live config by the caller; we only have keys here,
  // so http probing requires the raw record — see rawHeaders on the caller side.
  const res = await fetch(s.url!, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
               ...(s as any).rawHeaders },
    body: JSON.stringify(INIT),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText.toLowerCase()}`);
  return [];
}

async function probeStdio(s: McpServerInfo, timeoutMs: number): Promise<string[]> {
  const bin = resolveBin(s.command!);
  if (!bin) throw new Error(`not found: ${s.command}`);
  const proc = Bun.spawn([bin, ...s.args], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env },
  });
  const kill = () => { try { proc.kill(); } catch {} };
  const timer = setTimeout(kill, timeoutMs);
  try {
    proc.stdin.write(JSON.stringify(INIT) + "\n");
    proc.stdin.write(JSON.stringify(LIST) + "\n");
    await proc.stdin.flush();
    const text = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error(`timeout (${timeoutMs}ms)`)), timeoutMs)),
    ]);
    const tools: string[] = [];
    let sawResponse = false;
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.id === 1 || msg?.id === 2) sawResponse = true;
      for (const t of msg?.result?.tools ?? []) if (t?.name) tools.push(String(t.name));
    }
    if (!sawResponse) throw new Error("no MCP response");
    return tools;
  } finally {
    clearTimeout(timer);
    kill();
  }
}
```

- [ ] **Step 3: 运行确认通过并提交**

```bash
bun test test/probe.test.ts
git add -A && git commit -m "feat: MCP probing with honest stdio/http distinction"
```

---

### Task 8: CLI 装配 — 全部纯文本命令

**Files:**
- Rewrite: `src/index.ts`
- Create: `src/commands.ts`
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: 前七个 Task 的全部导出
- Produces: `runCommand(argv: string[], out: (s: string) => void): Promise<number>` — 便于测试的纯函数式入口

- [ ] **Step 1: 写失败测试 `test/commands.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-cmd-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_ENV;
  delete process.env.TREAD_SHELL;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { runCommand } = await import("../src/commands.ts");

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCommand(args, (s) => { out += s; });
  return { code, out };
}

describe("commands", () => {
  test("create 输出一行路径", async () => {
    const { code, out } = await run(["create", "work"]);
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("created");
    expect(out).toContain("envs/work");
  });

  test("path 的四种参数形态", async () => {
    expect((await run(["path", "work"])).out.trim()).toMatch(/envs\/work$/);
    expect((await run(["path", "work", "claude"])).out.trim()).toMatch(/envs\/work\/\.claude$/);
    expect((await run(["path", "work", "claude", "skills"])).out.trim())
      .toMatch(/envs\/work\/\.claude\/skills$/);
    expect((await run(["path", "work", "kimi", "skills"])).out.trim())
      .toMatch(/envs\/work\/\.agents\/skills$/);
  });

  test("path 输出绝无颜色与多余字符", async () => {
    const { out } = await run(["path", "work"]);
    expect(out).not.toContain("\x1b[");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  test("未知环境给出 did-you-mean", async () => {
    const { code, out } = await run(["path", "wrok"]);
    expect(code).toBe(1);
    expect(out).toContain('no environment named "wrok"');
    expect(out).toContain('did you mean "work"');
  });

  test("use 未加载 shell 集成时明确报错", async () => {
    const { code, out } = await run(["use", "work"]);
    expect(code).toBe(1);
    expect(out).toContain("shell integration not loaded");
    expect(out).toContain('eval "$(tread init zsh)"');
  });

  test("_export 输出 export 行", async () => {
    const { code, out } = await run(["_export", "use", "work"]);
    expect(code).toBe(0);
    expect(out).toContain("export TREAD_ENV='work'");
    expect(out).toContain("export CLAUDE_CONFIG_DIR=");
  });

  test("status 表头与 agent 行", async () => {
    const { code, out } = await run(["status", "work"]);
    expect(code).toBe(0);
    expect(out).toContain("skills");
    expect(out).toContain("plugins");
    expect(out).toContain("claude");
    expect(out).toContain("not used yet");
  });

  test("skills 空环境提示为空而非报错", async () => {
    const { code, out } = await run(["skills", "work", "claude"]);
    expect(code).toBe(0);
    expect(out).toContain("0 skills");
  });

  test("init zsh / starship", async () => {
    expect((await run(["init", "zsh"])).out).toContain("tread()");
    expect((await run(["init", "starship"])).out).toContain("[env_var.tread]");
    expect((await run(["init", "tcsh"])).code).toBe(1);
  });

  test("rm --force 删除，rm 正在激活的环境被拒", async () => {
    await run(["create", "doomed"]);
    expect((await run(["rm", "doomed", "--force"])).code).toBe(0);
    process.env.TREAD_ENV = "work";
    const r = await run(["rm", "work", "--force"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("currently active");
    delete process.env.TREAD_ENV;
  });

  test("未知命令返回 1 并打印用法", async () => {
    const { code, out } = await run(["frobnicate"]);
    expect(code).toBe(1);
    expect(out).toContain("unknown command");
  });
});
```

- [ ] **Step 2: 实现 `src/commands.ts`**

包含：`create` / `use` / `deactivate` / `_export` / `ls --plain` / `status` / `show --plain` / `skills` / `plugins` / `mcp` / `hooks` / `path` / `exec` / `rm` / `doctor` / `init` / `help`。TUI 命令在非 TTY 或尺寸不足时调用同名的 `*Plain` 函数。

关键实现约束：
- `path`、`init`、`_export`、`exec` 直接 `out(text)`，不经 `color()`。
- 所有错误统一 `throw new Error(msg)`，由 `runCommand` 捕获后 `out(formatError(msg) + "\n")` 并返回 1。
- `exec` 用 `Bun.spawn(cmd, { env, stdio: ["inherit","inherit","inherit"] })`，`--home` 时额外设 `HOME=<envRoot>`。

- [ ] **Step 3: 重写 `src/index.ts` 为极薄入口**

```ts
#!/usr/bin/env bun
import { runCommand } from "./commands.ts";

process.exitCode = await runCommand(process.argv.slice(2), (s) => process.stdout.write(s));
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test test/commands.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: 类型检查与提交**

```bash
bunx tsc --noEmit
git add -A && git commit -m "feat: full plain-text command surface"
```

---

### Task 9: TUI

**Files:**
- Create: `src/tui/layout.ts`, `src/tui/ls.tsx`, `src/tui/show.tsx`, `src/tui/mount.ts`
- Modify: `tsconfig.json`（`jsx: "react-jsx"`、`jsxImportSource: "@opentui/react"`）
- Modify: `package.json`（加 `@opentui/react`、`react`）
- Test: `test/layout.test.ts`

**Interfaces:**
- Consumes: `inventory`、`listEnvs`、`lastUsed`、`activationEnv`
- Produces:
  - `pickLayout(w: number, h: number): { mode: "full"|"wide"|"narrow"|"minimal"|"plain"; columns: number; showDetail: boolean }`
  - `mountLs(opts: { emit?: string }): Promise<number>`
  - `mountShow(envName: string): Promise<number>`

- [ ] **Step 1: 写失败测试 `test/layout.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
const { pickLayout } = await import("../src/tui/layout.ts");

describe("pickLayout", () => {
  test("宽度断点", () => {
    expect(pickLayout(100, 30).mode).toBe("full");
    expect(pickLayout(70, 30).mode).toBe("wide");
    expect(pickLayout(50, 30).mode).toBe("narrow");
    expect(pickLayout(35, 30).mode).toBe("minimal");
    expect(pickLayout(29, 30).mode).toBe("plain");
  });
  test("高度不足也退化", () => {
    expect(pickLayout(100, 7).mode).toBe("plain");
    expect(pickLayout(100, 10).showDetail).toBe(false);
  });
  test("列数随宽度收缩", () => {
    expect(pickLayout(100, 30).columns).toBe(3);
    expect(pickLayout(50, 30).columns).toBe(2);
    expect(pickLayout(35, 30).columns).toBe(1);
  });
});
```

- [ ] **Step 2: 实现 `src/tui/layout.ts`**

```ts
export const MIN_WIDTH = 30;
export const MIN_HEIGHT = 8;

export type LayoutMode = "full" | "wide" | "narrow" | "minimal" | "plain";

export interface Layout {
  mode: LayoutMode;
  /** how many table columns fit */
  columns: number;
  /** whether the ls detail pane / show section bodies fit */
  showDetail: boolean;
}

export function pickLayout(w: number, h: number): Layout {
  if (w < MIN_WIDTH || h < MIN_HEIGHT) return { mode: "plain", columns: 1, showDetail: false };
  const mode: LayoutMode = w >= 76 ? "full" : w >= 60 ? "wide" : w >= 44 ? "narrow" : "minimal";
  const columns = mode === "full" || mode === "wide" ? 3 : mode === "narrow" ? 2 : 1;
  return { mode, columns, showDetail: h >= 12 };
}
```

- [ ] **Step 3: 安装依赖并配置 JSX**

```bash
bun add @opentui/react react
bun add -d @types/react
```

`tsconfig.json` 的 `compilerOptions` 增加：

```json
{ "jsx": "react-jsx", "jsxImportSource": "@opentui/react" }
```

- [ ] **Step 4: 实测鼠标（阻断性验证，spec §15-1）**

在真实终端手工运行一个最小 opentui 程序，点击带 `onMouseDown` 的 box，确认事件触发。若不触发，改用纯键盘并从 footer 去掉所有鼠标提示。

- [ ] **Step 5: 实现 `src/tui/mount.ts`**

```ts
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

/** Mount a TUI and resolve once it asks to exit. */
export async function mount(render: (exit: (code?: number) => void) => ReactNode): Promise<number> {
  const renderer = await createCliRenderer();
  const root = createRoot(renderer);
  return await new Promise<number>((resolve) => {
    const exit = (code = 0) => { try { root.unmount?.(); } catch {} resolve(code); };
    root.render(render(exit));
  });
}
```

- [ ] **Step 6: 实现 `src/tui/ls.tsx` 与 `src/tui/show.tsx`**

按 spec §10 的界面：`ls` 为列表（`●` 生效环境、反白光标行、`⏎` 激活写入 `--emit` 文件、`s` 进 show、`c` 创建、`r` 删除）；`show` 为 agent tab（反白标识、`←→` 切换）+ 四类折叠区（`␣` 展开、`⏎` 进详情、`esc` 返回）。两者在 `pickLayout(...).mode === "plain"` 或 resize 到阈值以下时渲染 too-small 面板，不退出。

- [ ] **Step 7: 运行测试、编译、冒烟并提交**

```bash
bun test
bunx tsc --noEmit
bun build --compile src/index.ts --outfile /tmp/tread-smoke && /tmp/tread-smoke --help
git add -A && git commit -m "feat: opentui TUI for ls and show"
```

---

### Task 10: 收尾 — install.sh、README、e2e

**Files:**
- Rewrite: `install.sh`, `README.md`
- Create: `test/e2e.test.ts`
- Modify: `package.json`（version → `0.2.0`）

- [ ] **Step 1: 写 e2e 测试 `test/e2e.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string, state: string;
const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-e2e-"));
  state = path.join(tmp, "state");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function tread(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, TREAD_STATE_DIR: state, NO_COLOR: "1", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { out, err, code };
}

describe("e2e: create -> install a skill -> status sees it -> remove", () => {
  test("完整链路", async () => {
    expect((await tread(["create", "e2e"])).code).toBe(0);

    const root = path.join(state, "envs", "e2e");
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".kimi-code/config.toml"))).toBe(true);

    // simulate an installer dropping a skill into the environment
    const sd = path.join(root, ".claude/skills/demo");
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "SKILL.md"),
      "---\nname: demo\nversion: 2.0.0\ndescription: a demo\n---\n");

    const list = await tread(["skills", "e2e", "claude"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("demo");
    expect(list.out).toContain("2.0.0");

    const st = await tread(["status", "e2e"]);
    expect(st.out).toMatch(/claude\s+1\b/);

    const p = await tread(["path", "e2e", "claude", "skills"]);
    expect(p.out.trim()).toBe(path.join(root, ".claude/skills"));

    expect((await tread(["rm", "e2e", "--force"])).code).toBe(0);
    expect(fs.existsSync(root)).toBe(false);
  }, 30000);

  test("exec 透传退出码", async () => {
    await tread(["create", "x"]);
    expect((await tread(["exec", "x", "--", "false"])).code).toBe(1);
    expect((await tread(["exec", "x", "--", "true"])).code).toBe(0);
  }, 20000);

  test("exec 注入隔离变量", async () => {
    const r = await tread(["exec", "x", "--", "sh", "-c", "echo $CLAUDE_CONFIG_DIR"]);
    expect(r.out.trim()).toBe(path.join(state, "envs/x/.claude"));
  }, 20000);

  test("exec --home 才改 HOME", async () => {
    const a = await tread(["exec", "x", "--", "sh", "-c", "echo $HOME"]);
    expect(a.out.trim()).toBe(process.env.HOME);
    const b = await tread(["exec", "x", "--home", "--", "sh", "-c", "echo $HOME"]);
    expect(b.out.trim()).toBe(path.join(state, "envs/x"));
  }, 20000);
});
```

- [ ] **Step 2: 重写 `install.sh`（只剩编译一步）**

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${TREAD_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"

echo "==> compiling tread -> $BIN_DIR/tread"
# works around the bun 1.3.12 regression that emits a corrupt macho signature
BUN_NO_CODESIGN_MACHO_BINARY=1 bun build --compile --minify \
  "$REPO_DIR/src/index.ts" --outfile "$BIN_DIR/tread"

if [ "$(uname)" = "Darwin" ] && command -v codesign >/dev/null; then
  codesign --sign - --force "$BIN_DIR/tread"
fi

echo "==> done"
echo "add to your shell rc:  eval \"\$(tread init zsh)\""
```

- [ ] **Step 3: 重写 README**

覆盖：安装、shell 集成、`tread use` 后直接敲 agent、命令表、「tread 不管 skill/plugin/mcp/hooks 的安装」的明确声明与各 agent 原生用法、`tread exec --home` 的用途、claude 每环境需 `/login`、starship 集成。

- [ ] **Step 4: 全量验证并提交**

```bash
bun test
bunx tsc --noEmit
./install.sh && tread --help && tread doctor
git add -A && git commit -m "chore: single-step installer, README, e2e coverage"
```

---

## Self-Review

**Spec 覆盖检查：**

| Spec 章节 | 落地 Task |
|---|---|
| §3 关键事实 | Task 1（适配器表）、Task 2（凭证 symlink） |
| §4 只做 Layer A | 全程；Task 1 Step 7 删除包装层 |
| §5 数据模型 | Task 1、Task 2 |
| §6 激活机制 | Task 3 |
| §7 命令面 | Task 8 |
| §8 只读解析层 | Task 4、Task 5 |
| §9 MCP 状态 | Task 7 |
| §10 TUI | Task 9 |
| §11 纯文本输出 | Task 6、Task 8 |
| §12 错误样式 | Task 2（`requireEnv` 的 did-you-mean）、Task 6（`formatError`）、Task 8（shell-not-loaded） |
| §13 删除清单 | Task 1 Step 7、Task 10 Step 2 |
| §14 测试策略 | 各 Task 的测试 + Task 10 的 e2e |
| §15 待验证项 | Task 9 Step 4（鼠标，阻断性） |

**类型一致性：** `Agent` / `AgentSpec` 出自 `src/agents.ts`；`SkillInfo` / `PluginInfo` / `McpServerInfo` / `HookInfo` / `Inventory` / `MASK` 出自 `src/inspect/types.ts`；`ProbeResult` 出自 `src/probe.ts`。各 Task 引用的名称与定义处一致。

**已知缺口（实现时补齐）：** `probeHttp` 需要原始 header 值，而 `McpServerInfo` 出于安全只保留 key。实现 Task 7 时须在 `readMcp` 中额外返回一个不进入任何输出通路的 `rawHeaders`（用 `Object.defineProperty` 设为不可枚举，确保 `JSON.stringify` 不会泄露——Task 4 的测试已断言这一点）。
