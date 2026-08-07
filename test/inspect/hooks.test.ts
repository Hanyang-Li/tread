import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-hooks-"));
  for (const d of [".claude", ".cursor", ".kimi-code"]) {
    fs.mkdirSync(path.join(env, d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(env, ".claude/settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Grep|Glob", hooks: [{ type: "command", command: "gate.sh", timeout: 5 }] },
        ],
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "remind.sh" }] },
          { matcher: "resume", hooks: [{ type: "command", command: "remind.sh" }] },
          { matcher: "clear", hooks: [{ type: "command", command: "remind.sh" }] },
          { matcher: "*", hooks: [{ type: "command", command: "state.sh", timeout: 10 }] },
        ],
      },
    }),
  );
  fs.writeFileSync(
    path.join(env, ".cursor/hooks.json"),
    JSON.stringify({ hooks: { afterAgentResponse: [{ command: "bridge --source cursor" }] } }),
  );
  fs.writeFileSync(
    path.join(env, ".kimi-code/config.toml"),
    `default_model = "k3"

[[hooks]]
event = "SessionStart"
command = "state.sh session"
timeout = 10
`,
  );
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readHooks, hookCount, commandLabel } = await import("../../src/inspect/hooks.ts");

describe("commandLabel", () => {
  test("剥掉引号，并跳过解释器取真正跑的脚本", () => {
    // the bug this fixes: the list column rendered `node"` — quotes kept, and
    // the interpreter shown instead of the script that carries the meaning
    expect(
      commandLabel(
        '"/Users/me/.asdf/installs/nodejs/25.9.0/bin/node" ' +
          '"/env/.fintopia/scripts/agents/claude-session-start.mjs" claude-code',
      ),
    ).toBe("claude-session-start.mjs");
    expect(commandLabel("bash '/Users/me/.claude/hooks/herdr-agent-state.sh' session"))
      .toBe("herdr-agent-state.sh");
  });

  test("没有解释器时就是命令本身", () => {
    expect(commandLabel("~/.claude/hooks/cbm-session-reminder")).toBe("cbm-session-reminder");
    expect(commandLabel("bridge --source cursor")).toBe("bridge");
  });

  test("跳过 env 前缀和解释器参数", () => {
    expect(commandLabel("env FOO=1 BAR=2 node /x/run.mjs")).toBe("run.mjs");
    expect(commandLabel("python3 -u /x/tool.py")).toBe("tool.py");
  });

  test("只有解释器时不至于回退成空", () => {
    expect(commandLabel("node")).toBe("node");
    expect(commandLabel("")).toBe("");
  });
});

describe("readHooks", () => {
  test("claude: 同 event 同命令的 matcher 合并成一行，count 记真实条数", () => {
    const merged = readHooks(env, "claude").find((x) => x.command === "remind.sh")!;
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

  test("hookCount 报真实条数而非行数", () => {
    expect(hookCount(readHooks(env, "claude"))).toBe(5);
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
