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

  test("每个 agent 都有关掉自更新的办法", () => {
    // the invariant, not the values: an agent whose updater cannot be switched
    // off will install itself into an environment and outlive it
    for (const a of AGENTS) {
      const { vars, args } = AGENT_SPECS[a].noUpdate;
      expect(Object.keys(vars).length + args.length).toBeGreaterThan(0);
    }
    expect(AGENT_SPECS.kimi.noUpdate.vars).toEqual({
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_CLI_NO_AUTO_UPDATE: "1",
    });
    // cursor has no variable at all; a root option is its only switch
    expect(AGENT_SPECS.cursor.noUpdate).toEqual({ vars: {}, args: ["--disable-auto-update"] });
  });

  test("只有 kimi 会把更新装进环境里：另外两个的安装根目录是共享的", () => {
    expect(AGENT_SPECS.kimi.inEnvBin).toBe(".kimi-code/bin/kimi");
    expect(AGENT_SPECS.claude.inEnvBin).toBe(null);
    expect(AGENT_SPECS.cursor.inEnvBin).toBe(null);
  });

  test("目录名与 bin 名", () => {
    expect(AGENT_SPECS.claude.dir).toBe(".claude");
    expect(AGENT_SPECS.cursor.dir).toBe(".cursor");
    expect(AGENT_SPECS.kimi.dir).toBe(".kimi-code");
    expect(AGENT_SPECS.cursor.bin).toBe("cursor-agent");
  });
});
