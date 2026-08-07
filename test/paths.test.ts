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

  test("activationEnv 给出全部变量，含真 home 的传递", () => {
    const e = p.activationEnv("/e/work");
    expect(e.TREAD_ENV_DIR).toBe("/e/work");
    expect(e.TREAD_HOME).toBe(p.realHome());
    expect(e.CLAUDE_CONFIG_DIR).toBe("/e/work/.claude");
    expect(e.CURSOR_CONFIG_DIR).toBe("/e/work/.cursor");
    expect(e.CURSOR_DATA_DIR).toBe("/e/work/.cursor");
    expect(e.KIMI_CODE_HOME).toBe("/e/work/.kimi-code");
  });

  test("每个环境自己的 tread 文件都在 .tread 下", () => {
    expect(p.lastUsedFile("/e/work")).toBe("/e/work/.tread/last-used");
    expect(p.syncLockFile("/e/work")).toBe("/e/work/.tread/sync.lock");
  });

  test("realHome 认 TREAD_HOME，不被 shim 移动过的 HOME 骗到", () => {
    const prevHome = process.env.HOME;
    const prevState = process.env.TREAD_STATE_DIR;
    try {
      // exactly what an agent shelling out to tread sees
      process.env.HOME = "/e/work";
      process.env.TREAD_HOME = "/real/home";
      expect(p.realHome()).toBe("/real/home");
      delete process.env.TREAD_STATE_DIR;
      // the symptom this fixes: state resolved into the env, so `tread ls`
      // reported no environments at all
      expect(p.stateDir()).toBe("/real/home/.local/state/tread");
    } finally {
      delete process.env.TREAD_HOME;
      if (prevHome !== undefined) process.env.HOME = prevHome;
      if (prevState !== undefined) process.env.TREAD_STATE_DIR = prevState;
    }
  });
});
