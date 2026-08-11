import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-login-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { claudeServiceName } = await import("../src/login.ts");
const { AGENT_SPECS } = await import("../src/agents.ts");
const { activationEnv, isolateLoginFile } = await import("../src/paths.ts");

describe("claude keychain service name", () => {
  test("共享时没有后缀，就是真实 home 用的那个 item", () => {
    expect(claudeServiceName(null)).toBe("Claude Code-credentials");
  });

  test("隔离时后缀是 config dir 的 sha256 前 8 位", () => {
    // Golden values, measured against claude v2.1.227 on a real keychain: all
    // three items existed under exactly these names, which is what proved the
    // hash is over the config dir path and nothing else. They are plain sha256
    // of the string, so they hold on any machine — and if a claude release
    // changes the construction, these are what catches it.
    const base = "/Users/lihanyang/.local/state/tread/envs";
    expect(claudeServiceName(`${base}/cli-dev/.claude`))
      .toBe("Claude Code-credentials-61f37197");
    expect(claudeServiceName(`${base}/dw-bigdata/.claude`))
      .toBe("Claude Code-credentials-47051480");
    expect(claudeServiceName(`${base}/dw-skill-test/.claude`))
      .toBe("Claude Code-credentials-a52a432f");
  });

  test("路径先 NFC 归一，否则同一个目录会算出两个 item", () => {
    // claude normalises before hashing. A decomposed path — which is what the
    // macOS filesystem hands back — and its composed form name the same
    // directory, so they have to reach the same keychain entry.
    const decomposed = "/tmp/café/.claude";
    const composed = decomposed.normalize("NFC");
    expect(decomposed).not.toBe(composed);
    expect(claudeServiceName(decomposed)).toBe(claudeServiceName(composed));
  });
});

describe("loginVars", () => {
  test("claude 共享时是空字符串，而不是不设", () => {
    // the whole mechanism: claude drops the hash only when the variable is
    // *defined and empty*. An implementation that treated "" as absent, or a
    // shell that dropped an empty export, would silently restore the hash.
    const vars = AGENT_SPECS.claude.loginVars("/env/.claude", false);
    expect(vars.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    expect("CLAUDE_SECURESTORAGE_CONFIG_DIR" in vars).toBe(true);
  });

  test("claude 隔离时是环境自己的 config dir", () => {
    expect(AGENT_SPECS.claude.loginVars("/env/.claude", true))
      .toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/env/.claude" });
  });

  test("cursor 和 kimi 无需变量：共享 keychain 与 symlink 已经够了", () => {
    for (const a of ["cursor", "kimi"] as const) {
      expect(AGENT_SPECS[a].loginVars("/env/x", false)).toEqual({});
      expect(AGENT_SPECS[a].loginVars("/env/x", true)).toEqual({});
    }
  });
});

describe("activationEnv 跟随 per-env 标记", () => {
  test("默认共享：导出空字符串", () => {
    const root = path.join(tmp, "envs", "shared");
    fs.mkdirSync(path.join(root, ".tread"), { recursive: true });
    expect(activationEnv(root).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
  });

  test("有标记文件时导出 config dir，切换环境不会残留上一个的空值", () => {
    const root = path.join(tmp, "envs", "isolated");
    fs.mkdirSync(path.join(root, ".tread"), { recursive: true });
    fs.writeFileSync(isolateLoginFile(root, "claude"), "x");
    expect(activationEnv(root).CLAUDE_SECURESTORAGE_CONFIG_DIR)
      .toBe(path.join(root, ".claude"));
  });
});
