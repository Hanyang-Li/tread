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
