import { beforeAll, describe, expect, test } from "bun:test";

beforeAll(() => {
  process.env.TREAD_STATE_DIR = "/tmp/tread-paths-test";
});

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

  test("activationEnv 给出全部变量", () => {
    const e = p.activationEnv("/e/work");
    expect(e.TREAD_ENV_DIR).toBe("/e/work");
    expect(e.CLAUDE_CONFIG_DIR).toBe("/e/work/.claude");
    expect(e.CURSOR_CONFIG_DIR).toBe("/e/work/.cursor");
    expect(e.CURSOR_DATA_DIR).toBe("/e/work/.cursor");
    expect(e.KIMI_CODE_HOME).toBe("/e/work/.kimi-code");
  });
});
