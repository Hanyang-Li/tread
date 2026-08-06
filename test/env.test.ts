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

const {
  createEnv, ensureSkeleton, listEnvs, removeEnv, requireEnv, resolveEnv,
  touchLastUsed, lastUsed,
} = await import("../src/env.ts");
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

  test("requireEnv 给出 did-you-mean", () => {
    expect(() => requireEnv("wrok")).toThrow(/did you mean "work"/);
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
