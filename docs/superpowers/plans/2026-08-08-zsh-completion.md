# zsh 补全 `_tread` 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 tread 装上 zsh tab 补全 —— 补全函数文件 `_tread` 写在 `~/.local/share/tread/` 下，候选项一概向二进制现问。

**Architecture:** 语法在 zsh 里（哪个命令吃哪些位置参数和 flag），词汇在 TS 里（子命令名、环境名、agent 名、类别名、skill/plugin/MCP/hook 名）。二者通过一个隐藏子命令 `tread _complete` 连接，协议是一行一个候选、`值` 或 `值:描述`。`tread init zsh --write` 落文件，`tread doctor --fix` 修文件，`tread init zsh` 打印的片段负责把它接进 fpath。

**Tech Stack:** Bun + TypeScript（`bun test`）、zsh 的 `_arguments` / `_describe` 补全系统。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-08-zsh-completion-design.md`。有出入的地方在下面对应任务里标了「与 spec 的偏差」。
- 只做 zsh。bash / fish 补全不在范围内。
- 新路径一律走 `realHome()`，不用 `os.homedir()` —— agent 的 shim 会把 `HOME` 改成环境根目录。
- 写文件用 `writeFileAtomic()`（`src/atomic.ts`），不用 `fs.writeFileSync`。
- 注释写英文，风格随本仓库既有代码：解释「为什么」，不解释「是什么」。测试名写中文，随 `test/` 下既有写法。
- 每个任务结束跑一次 `bun test` 全量，全绿才提交。
- 提交信息用祈使句小写、无句号，末尾附：
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## 模块划分

| 文件 | 职责 |
|---|---|
| `src/paths.ts`（改） | 新增 `dataDir()` / `completionFile()`。所有路径推导仍集中在这一个文件 |
| `src/completion.ts`（新） | 补全的全部内容：`_tread` 脚本正文、候选项生成、`writeCompletion()` / `completionState()` |
| `src/shell.ts`（改） | zsh 片段末尾追加接线块；导出 `SHELLS` |
| `src/views.ts`（改） | `CATEGORIES` 由私有改为导出 |
| `src/commands.ts`（改） | `_complete` case、`init --write` 落文件、`doctor` 加一行 |

**依赖方向**：`commands.ts` → `{shell.ts, completion.ts, views.ts}`，`completion.ts` → `{shell.ts, views.ts, env.ts, inspect/}`。`shell.ts` **不得** import `completion.ts`，否则成环。

---

### Task 1: `dataDir()` 与 `completionFile()`

**Files:**
- Modify: `src/paths.ts`（文件末尾，`shimsDir()` 之后）
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: `realHome()`（同文件已有）
- Produces: `dataDir(): string`、`completionFile(): string`

- [ ] **Step 1: 写失败的测试**

改 `test/paths.test.ts` 顶部的 `beforeAll`，加一行环境变量：

```ts
beforeAll(() => {
  process.env.TREAD_STATE_DIR = "/tmp/tread-paths-test";
  process.env.TREAD_DATA_DIR = "/tmp/tread-paths-test/share";
});
```

在 `describe("paths", ...)` 块里追加两个 test：

```ts
  test("dataDir 认 TREAD_DATA_DIR，completionFile 落在其下", () => {
    expect(p.dataDir()).toBe("/tmp/tread-paths-test/share");
    expect(p.completionFile()).toBe("/tmp/tread-paths-test/share/_tread");
  });

  test("没有覆盖时 dataDir 走真实的 home，而不是被 shim 改过的 HOME", () => {
    const savedData = process.env.TREAD_DATA_DIR;
    const savedHome = process.env.TREAD_HOME;
    delete process.env.TREAD_DATA_DIR;
    process.env.TREAD_HOME = "/real/home";
    try {
      expect(p.dataDir()).toBe("/real/home/.local/share/tread");
    } finally {
      process.env.TREAD_DATA_DIR = savedData;
      if (savedHome === undefined) delete process.env.TREAD_HOME;
      else process.env.TREAD_HOME = savedHome;
    }
  });
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `bun test test/paths.test.ts`
Expected: FAIL，报 `p.dataDir is not a function`

- [ ] **Step 3: 实现**

在 `src/paths.ts` 的 `shimsDir()` 之后插入：

```ts
/**
 * Where tread writes files other tools read — the zsh completion, for now.
 *
 * The same shape as stateDir(), for the same two reasons: realHome() so that
 * an agent shelling out to tread does not write into the environment its shim
 * moved HOME to, and an override so tests can land somewhere temporary.
 */
export function dataDir(): string {
  return process.env.TREAD_DATA_DIR ?? path.join(realHome(), ".local/share/tread");
}

/** The zsh completion function. zsh autoloads it by this exact file name. */
export function completionFile(): string {
  return path.join(dataDir(), "_tread");
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `bun test test/paths.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat: a data dir, for the files other tools read

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `tread _complete` —— 候选项从二进制来

**Files:**
- Create: `src/completion.ts`
- Modify: `src/views.ts:97`（`CATEGORIES` 加 `export`）
- Modify: `src/shell.ts`（新增 `export const SHELLS`，并在 `initSnippet` 的报错里用它）
- Modify: `src/commands.ts`（`runCommand` 的 switch 里加 `_complete` case）
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `splitTargets()` / `isCategory()` / `CATEGORIES`（`src/views.ts`）、`listEnvs()` / `resolveEnv()`（`src/env.ts`）、`readSkills` / `readPlugins` / `readMcp` / `readHooks`（`src/inspect/index.ts`）、`AGENTS`（`src/agents.ts`）
- Produces:
  - `export interface Candidate { value: string; description?: string }`
  - `export const COMMANDS: Candidate[]`
  - `export function renderCandidate(c: Candidate): string`（导出只为可测，先例是 `src/inspect/skills.ts` 的 `parseFrontmatter`）
  - `export function complete(args: string[]): { code: number; text: string }`

- [ ] **Step 1: 写失败的测试**

在 `test/commands.test.ts` 顶部的 `beforeAll` 里加一行（后面 Task 4、5 都要用）：

```ts
  process.env.TREAD_DATA_DIR = path.join(tmp, "share");
```

把文件里那行 `const { runCommand } = await import("../src/commands.ts");` 换成（后面 Task 4、5 也都用这几个，一次加齐）：

```ts
const { runCommand, HELP } = await import("../src/commands.ts");
const { COMMANDS, renderCandidate } = await import("../src/completion.ts");
const { completionFile } = await import("../src/paths.ts");
```

这几行必须留在文件顶层。`describe` 的回调不是 async 函数，把 `await import` 写进去是语法错误。

`writeCompletion` 要等 Task 5 才用得上，Task 5 会自己把它加进这个 import。这里**不要**提前引 —— 它 Task 3 才存在，提前引会让 `bun run typecheck` 在 Task 2、3、4 之间一直是红的。

在 `describe("commands", ...)` 块末尾追加一个新的 describe（放在 `describe("commands")` 之后、文件末尾）：

```ts
describe("_complete", () => {
  beforeAll(() => {
    // a skill and an MCP server to complete, in an env that is not the active one
    const root = path.join(tmp, "state/envs/work");
    const skill = path.join(root, ".claude/skills/lark-mail");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: lark-mail\ndescription: \"飞书邮箱\"\n---\nbody\n",
    );
    fs.writeFileSync(
      path.join(root, ".claude/.mcp.json"),
      JSON.stringify({ mcpServers: { context7: { command: "npx", args: [] } } }),
    );
  });

  test("commands 列出子命令，且不吐隐藏的那两个", async () => {
    const { code, out } = await run(["_complete", "commands"]);
    expect(code).toBe(0);
    const names = out.trim().split("\n").map((l) => l.split(":")[0]);
    expect(names).toContain("use");
    expect(names).toContain("doctor");
    expect(names).not.toContain("_export");
    expect(names).not.toContain("_complete");
  });

  test("COMMANDS 与 HELP 不会各说各话", () => {
    for (const c of COMMANDS) {
      expect(HELP).toContain(`  ${c.value} `);
    }
  });

  test("envs 列出环境，激活的那个标 active", async () => {
    process.env.TREAD_ENV = "work";
    try {
      const { out } = await run(["_complete", "envs"]);
      expect(out).toContain("work:active");
      expect(out).toMatch(/^other$/m);
    } finally {
      delete process.env.TREAD_ENV;
    }
  });

  test("shells 出四个", async () => {
    const { out } = await run(["_complete", "shells"]);
    expect(out.trim().split("\n").sort()).toEqual(["bash", "fish", "starship", "zsh"]);
  });

  test("targets 第一格给环境名和 agent 名，不给 skill 名", async () => {
    const { out } = await run(["_complete", "targets", "skills"]);
    const names = out.trim().split("\n").map((l) => l.split(":")[0]);
    expect(names).toContain("work");
    expect(names).toContain("claude");
    expect(names).not.toContain("lark-mail");
  });

  test("targets 第二格同时给 agent 名和 skill 名，因为两者都可能", async () => {
    const { out } = await run(["_complete", "targets", "skills", "work"]);
    const names = out.trim().split("\n").map((l) => l.split(":")[0]);
    expect(names).toContain("kimi");
    expect(names).toContain("lark-mail");
    expect(names).not.toContain("work");
  });

  test("targets 给全 env 和 agent 后只剩 item 名", async () => {
    const { out } = await run(["_complete", "targets", "skills", "work", "claude"]);
    expect(out.trim().split("\n").map((l) => l.split(":")[0])).toEqual(["lark-mail"]);
  });

  test("targets 三格填满后不再给候选", async () => {
    const { out } = await run(["_complete", "targets", "skills", "work", "claude", "lark-mail"]);
    expect(out).toBe("");
  });

  test("mcp 的名字来自 .mcp.json，纯 zsh 拿不到的那类", async () => {
    const { out } = await run(["_complete", "targets", "mcp", "work", "claude"]);
    expect(out).toContain("context7");
  });

  test("path 的末格是类别，且要等 agent 定下来才出", async () => {
    const two = await run(["_complete", "targets", "path", "work"]);
    expect(two.out).not.toContain("plugins");
    const three = await run(["_complete", "targets", "path", "work", "claude"]);
    expect(three.out.trim().split("\n")).toEqual(["skills", "plugins", "mcp", "hooks"]);
  });

  test("没指定环境又没有激活环境时，输出空而不是报错文本", async () => {
    delete process.env.TREAD_ENV;
    const { code, out } = await run(["_complete", "targets", "skills", "claude"]);
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("未知请求安静退 1，stdout 一个字都不写", async () => {
    const { code, out } = await run(["_complete", "bogus"]);
    expect(code).toBe(1);
    expect(out).toBe("");
  });

  // 两条都直接打在 renderCandidate 上。走不了 fixture：skill 的 frontmatter
  // 解析器是逐行的，描述里塞不进换行；而带冒号的目录名在 macOS 上不可靠。
  test("值里的冒号要转义，否则 _describe 会把候选拦腰截断", () => {
    expect(renderCandidate({ value: "a:b" })).toBe("a\\:b");
    expect(renderCandidate({ value: "a:b", description: "d" })).toBe("a\\:b:d");
  });

  test("描述里的换行被压平，否则一条候选会裂成好几条", () => {
    expect(renderCandidate({ value: "x", description: " one\ntwo \n" })).toBe("x:one two");
    expect(renderCandidate({ value: "x", description: "" })).toBe("x");
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `bun test test/commands.test.ts`
Expected: FAIL，报找不到 `../src/completion.ts`

- [ ] **Step 3: 实现**

先把 `src/views.ts:97` 的 `CATEGORIES` 导出：

```ts
export const CATEGORIES = ["skills", "plugins", "mcp", "hooks"] as const;
```

在 `src/shell.ts` 顶部（`import` 之后）加：

```ts
/** Everything `tread init` takes. The completion asks for this list by name. */
export const SHELLS = ["zsh", "bash", "fish", "starship"] as const;
```

并把 `initSnippet` 的报错改成用它（输出文本不变）：

```ts
      throw new Error(
        `unknown shell "${target}"\n\n  supported: ${SHELLS.join(", ")}`,
      );
```

新建 `src/completion.ts`：

```ts
import { AGENTS, type Agent } from "./agents.ts";
import { listEnvs, resolveEnv } from "./env.ts";
import { readHooks, readMcp, readPlugins, readSkills } from "./inspect/index.ts";
import { SHELLS } from "./shell.ts";
import { CATEGORIES, isCategory, splitTargets, type Category } from "./views.ts";

export interface Candidate {
  value: string;
  description?: string;
}

/**
 * Every subcommand the completion offers, with the summary zsh shows beside it.
 *
 * `_export` and `_complete` are deliberately absent: they exist for the shell
 * function and for this file, and nobody types them. A test holds this list
 * against HELP so the two cannot drift apart.
 */
export const COMMANDS: Candidate[] = [
  { value: "init", description: "print shell integration" },
  { value: "create", description: "create an environment" },
  { value: "cp", description: "copy an environment" },
  { value: "use", description: "activate it in this shell" },
  { value: "deactivate", description: "leave the active environment" },
  { value: "ls", description: "browse and switch environments" },
  { value: "status", description: "what each environment holds" },
  { value: "show", description: "browse one environment" },
  { value: "skills", description: "list or inspect skills" },
  { value: "plugins", description: "list or inspect plugins" },
  { value: "mcp", description: "list or inspect MCP servers" },
  { value: "hooks", description: "list or inspect hooks" },
  { value: "path", description: "print a directory" },
  { value: "exec", description: "run a command in an environment" },
  { value: "rm", description: "delete an environment" },
  { value: "doctor", description: "check the setup" },
];

/**
 * One candidate per line, `value` or `value:description`.
 *
 * Both halves need cleaning up. zsh's _describe reads the first unescaped
 * colon as the split, so a colon inside a value would silently truncate it;
 * and a description spanning lines — a skill's, typically — would read back
 * as several candidates.
 */
export function renderCandidate(c: Candidate): string {
  const value = c.value.replaceAll(":", "\\:");
  const description = c.description?.replace(/\s+/g, " ").trim();
  return description ? `${value}:${description}` : value;
}

function envCandidates(): Candidate[] {
  const active = process.env.TREAD_ENV;
  return listEnvs().map((name) => ({
    value: name,
    description: name === active ? "active" : undefined,
  }));
}

function agentCandidates(): Candidate[] {
  return AGENTS.map((a) => ({ value: a }));
}

function itemCandidates(root: string, a: Agent, cat: Category): Candidate[] {
  switch (cat) {
    case "skills":
      return readSkills(root, a).map((s) => ({
        value: s.name,
        description: s.description ?? undefined,
      }));
    case "plugins":
      return readPlugins(root, a).map((p) => ({
        value: p.name,
        description: p.description ?? undefined,
      }));
    case "mcp":
      return readMcp(root, a).map((m) => ({ value: m.name, description: m.transport }));
    case "hooks": {
      // readHooks returns one row per handler, so an event with two handlers
      // would otherwise be offered twice
      const events = new Set(readHooks(root, a).map((h) => h.event));
      return [...events].sort().map((e) => ({ value: e }));
    }
  }
}

/**
 * Candidates for the next positional of `[env] [agent] [name]`.
 *
 * The words already typed go straight back through splitTargets(), so the
 * "first word that is not an agent is the environment" rule stays in the one
 * place that already owns it. Which slot is open falls out of what it returns.
 */
function targetCandidates(cmd: string, typed: string[]): Candidate[] {
  const { envName, agent, name } = splitTargets(typed);
  if (name !== null) return [];

  const out: Candidate[] = [];
  // an item name is not reachable in the first slot: splitTargets would read
  // it as an environment, whatever it happens to be
  if (envName === null && agent === null) out.push(...envCandidates());
  if (agent === null) out.push(...agentCandidates());

  // `path` names a category last, and pathCommand only reads one once the
  // agent is settled — before that the word is swallowed as the agent slot
  if (cmd === "path") {
    if (agent !== null) out.push(...CATEGORIES.map((c) => ({ value: c })));
    return out;
  }

  // the item slot opens as soon as either leading slot is settled: `tread
  // skills work <TAB>` may still be naming an agent, but it may equally be
  // naming a skill, which categoryCommand resolves against claude by default
  if (!isCategory(cmd) || (envName === null && agent === null)) return out;
  try {
    out.push(...itemCandidates(resolveEnv(envName ?? undefined), agent ?? "claude", cmd));
  } catch {
    // nothing typed and nothing active: there is no environment to read
  }
  return out;
}

/**
 * `tread _complete <what> [...]` — the data half of the zsh completion.
 *
 * Hidden the way `_export` is: an implementation detail of `_tread`, not a
 * command anyone types. An unknown request exits 1 and writes nothing, so a
 * `_tread` left over from an older tread can ask for something this binary
 * does not have and simply get no suggestions.
 */
export function complete(args: string[]): { code: number; text: string } {
  const [what, ...rest] = args;
  let list: Candidate[];
  switch (what) {
    case "commands":
      list = COMMANDS;
      break;
    case "shells":
      list = SHELLS.map((s) => ({ value: s }));
      break;
    case "envs":
      list = envCandidates();
      break;
    case "targets": {
      const [cmd, ...typed] = rest;
      if (!cmd) return { code: 1, text: "" };
      list = targetCandidates(cmd, typed);
      break;
    }
    default:
      return { code: 1, text: "" };
  }
  return { code: 0, text: list.length ? list.map(renderCandidate).join("\n") + "\n" : "" };
}
```

在 `src/commands.ts` 里：把 `const HELP = ...` 改成 `export const HELP = ...`（测试要拿它做一致性校验）；在 import 区加

```ts
import { complete } from "./completion.ts";
```

在 `runCommand` 的 switch 中，`case "_export"` 之后插入：

```ts
      case "_complete": {
        const { code, text } = complete(args);
        if (text) out(text);
        return code;
      }
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `bun test`
Expected: 全绿。若 `COMMANDS 与 HELP 不会各说各话` 失败，说明 HELP 里那一行的缩进不是两个空格 —— 对照 `src/commands.ts` 的 HELP 常量把 `COMMANDS` 的名字改对，不要放宽断言。

- [ ] **Step 5: 提交**

```bash
git add src/completion.ts src/commands.ts src/shell.ts src/views.ts test/commands.test.ts
git commit -m "feat: tread _complete answers what the shell is about to ask

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `_tread` 脚本正文，与它的读写

**Files:**
- Modify: `src/completion.ts`
- Test: `test/completion.test.ts`（新建）

**Interfaces:**
- Consumes: `completionFile()`（`src/paths.ts`）、`writeFileAtomic()`（`src/atomic.ts`）
- Produces:
  - `export const ZSH_COMPLETION: string`
  - `export function writeCompletion(): void`
  - `export function completionState(): "ok" | "stale" | "missing"`

**注**：下面这段 zsh 脚本已用 `zsh -n` 验过能解析，`${fpath:#...}` 的幂等性和 `${(M)words[...]:#[^-]*}` 的过滤行为也单独验过。原样抄，不要改动引号。

- [ ] **Step 1: 写失败的测试**

新建 `test/completion.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-completion-"));
  process.env.TREAD_DATA_DIR = path.join(tmp, "share");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { ZSH_COMPLETION, writeCompletion, completionState } =
  await import("../src/completion.ts");
const { completionFile } = await import("../src/paths.ts");

describe("completion file", () => {
  test("是一个 zsh 补全函数文件，候选一概问二进制", () => {
    expect(ZSH_COMPLETION.startsWith("#compdef tread\n")).toBe(true);
    expect(ZSH_COMPLETION).toContain("command tread _complete");
    expect(ZSH_COMPLETION.trimEnd().endsWith('_tread "$@"')).toBe(true);
  });

  test("zsh 能解析它", async () => {
    const zsh = Bun.which("zsh");
    if (!zsh) return; // no zsh on this machine — nothing to check against
    const f = path.join(tmp, "_tread");
    fs.writeFileSync(f, ZSH_COMPLETION);
    const proc = Bun.spawn([zsh, "-n", f], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(code).toBe(0);
  });

  test("写之前是 missing，写完是 ok，改一个字就是 stale", () => {
    expect(completionState()).toBe("missing");
    writeCompletion();
    expect(fs.readFileSync(completionFile(), "utf8")).toBe(ZSH_COMPLETION);
    expect(completionState()).toBe("ok");
    fs.appendFileSync(completionFile(), "# hand-edited\n");
    expect(completionState()).toBe("stale");
    writeCompletion();
    expect(completionState()).toBe("ok");
  });

  test("目录不存在也能写", () => {
    fs.rmSync(path.dirname(completionFile()), { recursive: true, force: true });
    writeCompletion();
    expect(completionState()).toBe("ok");
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `bun test test/completion.test.ts`
Expected: FAIL，报 `ZSH_COMPLETION` 未导出

- [ ] **Step 3: 实现**

在 `src/completion.ts` 顶部 import 区补两行：

```ts
import fs from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { completionFile } from "./paths.ts";
```

在文件末尾追加：

```ts
/**
 * The zsh completion function.
 *
 * The grammar is here — which command takes which positionals and flags — and
 * nothing else is: every candidate comes from `tread _complete` at the moment
 * TAB is pressed. So a file left behind by an older tread still completes a
 * command that binary has since grown; only the flags would be missing.
 */
export const ZSH_COMPLETION = `#compdef tread

# Generated by \`tread init zsh --write\`; \`tread doctor --fix\` rewrites it.
# Do not edit: the grammar lives here, every candidate comes from the binary.

_tread_ask() {
  local tag=$1; shift
  local -a candidates
  candidates=(\${(f)"$(command tread _complete "$@" 2>/dev/null)"})
  (( $#candidates )) || return 1
  _describe -t "$tag" "$tag" candidates
}

_tread_envs()   { _tread_ask environment envs }
_tread_shells() { _tread_ask shell shells }

# tread reads \`[env] [agent] [name]\` by position, so the flags typed so far are
# dropped and the rest handed over exactly as tread itself would read them.
_tread_targets() {
  local -a typed
  typed=(\${(M)words[2,CURRENT-1]:#[^-]*})
  _tread_ask target targets $words[1] $typed
}

_tread() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '(- *)'{-h,--help}'[show help]' \\
    '(- *)'{-v,--version}'[show the version]' \\
    '1: :->cmd' \\
    '*:: :->args'

  case $state in
    cmd)
      _tread_ask command commands
      ;;
    args)
      case $words[1] in
        init)
          _arguments \\
            '(-w --write)'{-w,--write}'[append it to your shell rc]' \\
            '1:shell:_tread_shells'
          ;;
        use|status)
          _arguments '1:environment:_tread_envs'
          ;;
        show)
          _arguments '--plain[print instead of opening the TUI]' \\
                     '1:environment:_tread_envs'
          ;;
        ls)
          _arguments '--plain[print instead of opening the TUI]'
          ;;
        cp)
          _arguments '1:source:_tread_envs' '2:new name: '
          ;;
        rm)
          _arguments '(-f --force)'{-f,--force}'[skip the confirmation]' \\
                     '1:environment:_tread_envs'
          ;;
        doctor)
          _arguments '--fix[repair what it can]' '1:environment:_tread_envs'
          ;;
        exec)
          _arguments '--home[point HOME at the environment]' \\
                     '1:environment:_tread_envs' \\
                     '(-)*::command:_normal'
          ;;
        mcp)
          _arguments '--probe[contact each server]' '*: :_tread_targets'
          ;;
        skills|plugins|hooks|path)
          _tread_targets
          ;;
      esac
      ;;
  esac
}

_tread "$@"
`;

/**
 * Atomic for the same reason the shims are: compinit may be reading this file
 * right now, and a truncate-then-write would hand it half a function.
 */
export function writeCompletion(): void {
  writeFileAtomic(completionFile(), ZSH_COMPLETION);
}

/** Missing, or written by a tread that is no longer the one on PATH. */
export function completionState(): "ok" | "stale" | "missing" {
  let text: string;
  try {
    text = fs.readFileSync(completionFile(), "utf8");
  } catch {
    return "missing";
  }
  return text === ZSH_COMPLETION ? "ok" : "stale";
}
```

**注意模板字符串的转义**：脚本里的 `` ` ``、`${` 和行尾续行的 `\` 都必须转义成 `` \` ``、`\${`、`\\`。上面已经处理好了 —— `$1`、`$@`、`$words`、`$#candidates`、`$state`、`$curcontext` 这些**单个 `$` 不跟 `{`** 的不需要转义，`\${(f)...}`、`\${(M)...}`、`\${...:#...}` 需要。

- [ ] **Step 4: 跑测试，确认通过**

Run: `bun test test/completion.test.ts`
Expected: PASS，包括 `zsh -n` 那条

再手工核对一次转义没写错：

```bash
bun -e 'const {ZSH_COMPLETION}=await import("./src/completion.ts");await Bun.write("/tmp/_tread_check",ZSH_COMPLETION)' \
  && zsh -n /tmp/_tread_check && grep -c '\${(f)' /tmp/_tread_check
```
Expected: 无输出即解析通过，`grep -c` 输出 `1`（说明 `${(f)` 原样落到了文件里，没被 JS 吃掉）

- [ ] **Step 5: 提交**

```bash
git add src/completion.ts test/completion.test.ts
git commit -m "feat: the _tread completion function, and how it is written

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 接线 —— zsh 片段与 `init zsh --write`

**Files:**
- Modify: `src/shell.ts`（`posix()`）
- Modify: `src/commands.ts`（`case "init"` 的 `--write` 分支）
- Test: `test/shell.test.ts`、`test/commands.test.ts`

**Interfaces:**
- Consumes: `dataDir()` / `completionFile()`（Task 1）、`writeCompletion()` / `completionState()`（Task 3）
- Produces: 无新导出。`initSnippet("zsh")` 的输出多一个接线块；`init zsh --write` 多写一个文件、多一行 stderr

**与 spec 的偏差**：spec §8 让 `writeInit()` 自己去写 `_tread`。这里改成由 `commands.ts` 在 `writeInit()` 之后调 `writeCompletion()`。理由是 `completion.ts` 要 import `shell.ts` 的 `SHELLS`（Task 2），如果 `shell.ts` 反过来 import `completion.ts` 就成环了。`writeInit` 的返回类型因此不变。

- [ ] **Step 1: 写失败的测试**

`test/shell.test.ts`，在 `describe("shell integration", ...)` 里追加：

```ts
  test("zsh 片段把补全接进 fpath，bash 片段不接", () => {
    const z = initSnippet("zsh");
    expect(z).toContain("autoload -Uz _tread");
    expect(z).toContain("compdef _tread tread");
    // guarded three ways: a file that was never written, a doubly-sourced rc,
    // and an eval line that lands before compinit
    expect(z).toContain("[[ -r ");
    expect(z).toContain("${fpath:#");
    expect(z).toContain("$+functions[compdef]");
    expect(initSnippet("bash")).not.toContain("compdef");
  });

  test("zsh 片段能被 zsh 解析", async () => {
    const zsh = Bun.which("zsh");
    if (!zsh) return;
    const f = path.join(tmp, "snippet.zsh");
    fs.writeFileSync(f, initSnippet("zsh"));
    const proc = Bun.spawn([zsh, "-n", f], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });
```

`test/commands.test.ts`，在 `describe("_complete", ...)` 之后追加：

```ts
describe("init --write 装补全", () => {
  // init --write appends to the rc file, which rcFile() derives from $HOME —
  // point it somewhere disposable before letting this near a real ~/.zshrc
  beforeAll(() => {
    process.env.HOME = path.join(tmp, "fakehome");
    fs.mkdirSync(process.env.HOME, { recursive: true });
  });

  test("zsh 第一次是 written，第二次是 rewritten", async () => {
    let err = "";
    const first = await runCommand(["init", "zsh", "--write"], () => {}, (s) => {
      err += s;
    });
    expect(first).toBe(0);
    expect(err).toContain("completion written to");
    expect(fs.existsSync(completionFile())).toBe(true);

    err = "";
    await runCommand(["init", "zsh", "--write"], () => {}, (s) => {
      err += s;
    });
    expect(err).toContain("completion rewritten at");
  });

  test("被手改过的补全，--write 无条件盖回去", async () => {
    fs.appendFileSync(completionFile(), "# hand-edited\n");
    await runCommand(["init", "zsh", "--write"], () => {}, () => {});
    expect(fs.readFileSync(completionFile(), "utf8")).not.toContain("hand-edited");
  });

  test("bash 的 --write 不碰补全", async () => {
    fs.rmSync(completionFile(), { force: true });
    let err = "";
    await runCommand(["init", "bash", "--write"], () => {}, (s) => {
      err += s;
    });
    expect(err).not.toContain("completion");
    expect(fs.existsSync(completionFile())).toBe(false);
  });
});
```

`completionFile` 已在 Task 2 的 Step 1 加进文件顶层的 import 了，不要在 `describe` 回调里再 `await import` 一次 —— 那是语法错误。

上面那个 `beforeAll` 是这个 describe 里最要紧的一行：`init --write` 会往 `rcFile()` 追加，而 `rcFile()` 走 `os.homedir()`（bun 下读 `$HOME`）。不改掉它，跑一次测试就往你自己的 `~/.zshrc` 里追加了一段。改了之后不必还原 —— `HOME` 只影响这个测试进程，`tmp` 会被文件级 `afterAll` 整个删掉。

- [ ] **Step 2: 跑测试，确认它失败**

Run: `bun test test/shell.test.ts test/commands.test.ts`
Expected: FAIL，`initSnippet("zsh")` 不含 `compdef`；`completion written to` 找不到

- [ ] **Step 3: 实现**

`src/shell.ts`：import 里加上新路径

```ts
import { activationEnv, completionFile, dataDir, shimsDir } from "./paths.ts";
```

在 `posix()` 之前加一个生成接线块的函数：

```ts
/**
 * Wire the completion into zsh — if it is there.
 *
 * Three guards, one for each way this goes wrong. `-r`: the file is written by
 * `init zsh --write`, and someone who added the eval line by hand has never run
 * it, so compdef would register a function that does not exist and the first
 * TAB would fail. `${fpath:#…}`: a nested shell or a doubly-sourced rc would
 * otherwise grow fpath without bound — dropping the entry before prepending it
 * makes the block idempotent. `$+functions[compdef]`: compdef only exists once
 * compinit has run, and the eval line may well come first; in that order the
 * fpath entry alone is enough, because compinit picks it up itself.
 */
function zshCompletion(): string {
  const dir = q(dataDir());
  return `if [[ -r ${q(completionFile())} ]]; then
  fpath=(${dir} \${fpath:#${dir}})
  (( $+functions[compdef] )) && { autoload -Uz _tread && compdef _tread tread }
fi
`;
}
```

（`q()` 定义在文件下方，函数声明会提升，直接用即可。）

把 `posix()` 的返回值末尾接上它，只对 zsh：

```ts
export TREAD_SHELL=${shell}
${shell === "zsh" ? zshCompletion() : ""}`;
```

`src/commands.ts`：import 里加

```ts
import { complete, completionState, writeCompletion } from "./completion.ts";
import { ..., completionFile, ... } from "./paths.ts";
```

在 `case "init"` 的 `if (write) { ... }` 块里，两个 `err(...)` 分支都走完之后、`return 0` 之前，插入：

```ts
          // bash and fish have no completion here, and starship is not a shell
          if (target === "zsh") {
            const first = completionState() === "missing";
            writeCompletion();
            err(
              `tread: completion ${first ? "written to" : "rewritten at"} ` +
                `${tildify(completionFile())}\n`,
            );
          }
          return 0;
```

注意 starship 分支里那个 `if (format)` 的 `err(...)` 在前面，两条路径最终都要落到这段上 —— 把它放在 `if (format) {...} else {...}` 之后。

- [ ] **Step 4: 跑测试，确认通过**

Run: `bun test`
Expected: 全绿

- [ ] **Step 5: 手工验一次真实交互**（补全是终端行为，测试断不到）

```bash
./install.sh
tread init zsh --write
exec zsh
tread <TAB>            # 出子命令 + 描述
tread use <TAB>        # 出环境名，当前激活的标 active
tread skills <TAB>     # 出环境名 + agent 名
tread doctor --<TAB>   # 出 --fix
```

- [ ] **Step 6: 提交**

```bash
git add src/shell.ts src/commands.ts test/shell.test.ts test/commands.test.ts
git commit -m "feat: init zsh installs the completion and puts it on fpath

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `doctor` 的那一行

**Files:**
- Modify: `src/commands.ts`（`doctorCommand`，`shell` 那一行之后）
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `completionState()` / `writeCompletion()`（Task 3）、`completionFile()`（Task 1）
- Produces: 无新导出

- [ ] **Step 1: 写失败的测试**

在 `test/commands.test.ts` 末尾追加：

```ts
describe("doctor 的 completion 一行", () => {
  test("文件不存在时报 not installed，且 --fix 不去创建它", async () => {
    fs.rmSync(completionFile(), { force: true });
    const plain = await run(["doctor"]);
    expect(plain.out).toContain("not installed");
    expect(plain.out).toContain("tread init zsh --write");

    // --fix repairs what is out of line; installing something never installed
    // is init's job, or a fish user would get a zsh file they never asked for
    await run(["doctor", "--fix"]);
    expect(fs.existsSync(completionFile())).toBe(false);
  });

  test("一致时 ok，被改过时 stale，--fix 后 regenerated 且真的重写了", async () => {
    writeCompletion();
    expect((await run(["doctor"])).out).toMatch(/^completion\s+ok/m);

    fs.appendFileSync(completionFile(), "# hand-edited\n");
    expect((await run(["doctor"])).out).toMatch(/^completion\s+stale/m);
    // a plain doctor reports and never writes
    expect(fs.readFileSync(completionFile(), "utf8")).toContain("hand-edited");

    expect((await run(["doctor", "--fix"])).out).toMatch(/^completion\s+regenerated/m);
    expect(fs.readFileSync(completionFile(), "utf8")).not.toContain("hand-edited");
  });
});
```

`completionFile` 已在 Task 2 的 Step 1 加进文件顶层的 import 了。`writeCompletion` 还没有 —— 把文件顶层那行补成：

```ts
const { COMMANDS, renderCandidate, writeCompletion } = await import("../src/completion.ts");
```

（Task 2 时它还不存在，提前引会让 `bun run typecheck` 变红，所以留到这里加。）

（`colorsEnabled()` 在非 TTY 下返回 false，`bun test` 的 stdout 不是 TTY，所以上面按纯文本断言是对的。若断言意外失败，先 `console.log(JSON.stringify(out))` 看清实际输出，不要盲改正则。）

- [ ] **Step 2: 跑测试，确认它失败**

Run: `bun test test/commands.test.ts`
Expected: FAIL，输出里没有 `completion` 这一行

- [ ] **Step 3: 实现**

在 `doctorCommand` 里，`rows.push([ "shell", ... ])` 之后紧接着插入：

```ts
  // next to the shell row: both are the shell integration. Reported, not
  // counted — like the shims row, it is shared setup, not an environment's
  // problem. --fix repairs a file that has fallen behind this binary, but
  // never creates one: installing it is `init zsh --write`'s job, and a fish
  // user running --fix should not end up with a zsh file.
  const comp = completionState();
  if (comp === "stale" && fix) writeCompletion();
  rows.push([
    "completion",
    comp === "ok" ? ok
    : comp === "missing" ? c.dim("not installed")
    : fix ? c.green("regenerated") : c.yellow("stale"),
    comp === "missing"
      ? `${tildify(completionFile())} · ${c.dim("tread init zsh --write")}`
      : tildify(completionFile()),
  ]);
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `bun test`
Expected: 全绿。特别确认 `doctor <env> 仍查公共项，但只查这一个环境` 那条仍过 —— 它有一句 `expect(out).not.toContain("other")`。

- [ ] **Step 5: 提交**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "feat: doctor reports a completion that has fallen behind

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: README

**Files:**
- Modify: `README.md:14-20`

- [ ] **Step 1: 改文档**

README 现在第 14–20 行是这样（从「然后把 shell 集成」到「fish 用 `tread init fish | source`。）」为止）：

~~~markdown
然后把 shell 集成加进 `~/.zshrc`：

```bash
eval "$(tread init zsh)"
```

（`bash` / `fish` 同理；fish 用 `tread init fish | source`。）
~~~

整段替换成：

~~~markdown
然后装 shell 集成：

```bash
tread init zsh --write
```

它做两件事：往 `~/.zshrc` 追加一行 `eval "$(tread init zsh)"`，以及把 tab 补全写到
`~/.local/share/tread/_tread` 并接进 `fpath`。补全覆盖子命令、环境名、agent 名、类别，
以及每个环境里实际装着的 skill / plugin / MCP server / hook event。

也可以只把这一行手抄进 `~/.zshrc`：

```bash
eval "$(tread init zsh)"
```

那样不装补全——片段发现 `_tread` 不在就安静跳过，`tread doctor` 会告诉你它没装。

（`bash` / `fish` 同理，但没有补全；fish 用 `tread init fish | source`。）
~~~

- [ ] **Step 2: 核对**

Run: `grep -n "_tread" README.md`
Expected: 命中新加的那两处

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: how the zsh completion gets installed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 自查记录

对着 spec 逐节点了一遍：

| spec 章节 | 落在哪 |
|---|---|
| §3 `dataDir()` / `completionFile()` | Task 1 |
| §4 片段自带 fpath、三个守卫 | Task 4 |
| §5 `_complete` 四个 case、冒号转义、空输出 | Task 2 |
| §5.1 `targets` 复用 `splitTargets` | Task 2 |
| §5.2 静态列表也走 `_complete` | Task 2（`COMMANDS` / `SHELLS` 都在 `_complete` 里，`_tread` 内不含词汇） |
| §6 `_tread` 结构、`exec` 的 `--` | Task 3 |
| §7 doctor 三态 | Task 5 |
| §8 `--write` 无条件重写与措辞 | Task 4（实现位置从 `writeInit` 挪到 `commands.ts`，见该任务的偏差说明） |
| §9 测试 | Task 1–5 各自的测试步骤 |
| §10 README、HELP 不动 | Task 6 |

未落地的 spec 内容：无。
