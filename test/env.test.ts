import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-test-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  process.env.TREAD_SHARE_DIR = path.join(tmp, "share");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// imports must come after env setup for share/state overrides to apply
const { envDir, isAgent, layout, skillsAgentFlag, validateEnvName } = await import("../src/paths.ts");
const { createEnv, listEnvs, parseAgentEnv, removeEnv, requireEnv } = await import("../src/env.ts");
const { showHooks, showMcp } = await import("../src/inspect.ts");

describe("paths", () => {
  test("validateEnvName", () => {
    expect(() => validateEnvName("demo-1.x")).not.toThrow();
    expect(() => validateEnvName("../evil")).toThrow();
    expect(() => validateEnvName("")).toThrow();
    expect(() => validateEnvName("a/b")).toThrow();
  });

  test("envDir is under state dir, classified by agent", () => {
    expect(envDir("claude", "demo")).toBe(path.join(process.env.TREAD_STATE_DIR!, "claude", "demo"));
  });

  test("isAgent", () => {
    expect(isAgent("claude")).toBe(true);
    expect(isAgent("vim")).toBe(false);
  });

  test("skillsAgentFlag", () => {
    expect(skillsAgentFlag("claude")).toBe("claude-code");
    expect(skillsAgentFlag("cursor")).toBe("cursor");
    expect(skillsAgentFlag("kimi")).toBe("kimi-code-cli");
  });

  test("parseAgentEnv", () => {
    expect(parseAgentEnv(["kimi", "x"])).toEqual({ agent: "kimi", name: "x" });
    expect(() => parseAgentEnv(["bad", "x"])).toThrow();
    expect(() => parseAgentEnv(["kimi"])).toThrow();
  });
});

describe("env lifecycle", () => {
  test("create/list/require/remove", () => {
    const dir = createEnv("claude", "demo");
    expect(dir).toBe(envDir("claude", "demo"));
    expect(fs.existsSync(layout("claude", dir).skillsDir)).toBe(true);
    expect(fs.existsSync(layout("claude", dir).pluginsDir)).toBe(true);
    expect(() => createEnv("claude", "demo")).toThrow(); // already exists

    expect(listEnvs()).toEqual({ claude: ["demo"], cursor: [], kimi: [] });
    expect(requireEnv("claude", "demo")).toBe(dir);
    expect(() => requireEnv("claude", "nope")).toThrow();

    removeEnv("claude", "demo");
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("kimi env writes extra_skill_dirs into config.toml", () => {
    const dir = createEnv("kimi", "k1");
    const cfg = fs.readFileSync(path.join(dir, ".kimi-code", "config.toml"), "utf8");
    const skillsDir = layout("kimi", dir).skillsDir;
    expect(cfg).toContain(`extra_skill_dirs = ["${skillsDir}"]`);
    expect(fs.existsSync(skillsDir)).toBe(true);
  });
});

describe("inspect", () => {
  function capture(fn: () => void): string {
    const orig = console.log;
    let out = "";
    console.log = (...a: any[]) => (out += a.join(" ") + "\n");
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return out;
  }

  test("mcp: reads mcpServers per agent", () => {
    const dir = createEnv("claude", "m1");
    fs.writeFileSync(
      layout("claude", dir).mcpFile,
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@mcp/github"] }, web: { url: "https://x" } } }),
    );
    const out = capture(() => showMcp("claude", "m1"));
    expect(out).toContain("github");
    expect(out).toContain("npx -y @mcp/github");
    expect(out).toContain("web");
    expect(out).toContain("https://x");
  });

  test("mcp: empty shows placeholder", () => {
    createEnv("cursor", "m2");
    expect(capture(() => showMcp("cursor", "m2"))).toContain("(no mcp servers)");
  });

  test("hooks: claude settings.json shape", () => {
    const dir = createEnv("claude", "h1");
    fs.writeFileSync(
      layout("claude", dir).hooksFile,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    const out = capture(() => showHooks("claude", "h1"));
    expect(out).toContain("PreToolUse [Bash]");
    expect(out).toContain("echo hi");
  });

  test("hooks: kimi config.toml [[hooks]]", () => {
    const dir = createEnv("kimi", "h2");
    fs.appendFileSync(
      layout("kimi", dir).hooksFile,
      `\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = "node check.mjs"\n`,
    );
    const out = capture(() => showHooks("kimi", "h2"));
    expect(out).toContain("PreToolUse [Bash]");
    expect(out).toContain("node check.mjs");
  });
});
