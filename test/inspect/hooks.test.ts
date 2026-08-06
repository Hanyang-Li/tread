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

const { readHooks, hookCount } = await import("../../src/inspect/hooks.ts");

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
