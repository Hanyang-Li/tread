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

  test("kimi 骨架不写 extra_skill_dirs：shim 移动 HOME 后原生就能发现", () => {
    const dir = envDir("work");
    const toml = path.join(dir, ".kimi-code/config.toml");
    if (fs.existsSync(toml)) {
      expect(fs.readFileSync(toml, "utf8")).not.toContain("extra_skill_dirs");
    }
  });

  test("kimi config 从真 home 播种 provider/model，但剥掉 hooks", () => {
    const real = path.join(os.homedir(), ".kimi-code/config.toml");
    if (!fs.existsSync(real)) return;
    const seeded = fs.readFileSync(path.join(envDir("work"), ".kimi-code/config.toml"), "utf8");
    expect(seeded).not.toContain("[[hooks]]");
    if (fs.readFileSync(real, "utf8").includes("default_model")) {
      expect(seeded).toContain("default_model");
    }
  });

  test("HOME 被劫持后 git/ssh 仍可用：共享文件已 symlink", () => {
    const dir = envDir("work");
    for (const rel of [".gitconfig", ".ssh"]) {
      if (!fs.existsSync(path.join(os.homedir(), rel))) continue;
      expect(fs.lstatSync(path.join(dir, rel)).isSymbolicLink()).toBe(true);
    }
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
