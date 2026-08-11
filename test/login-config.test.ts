import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-loginconf-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_ENV;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { createEnv, ensureSkeleton } = await import("../src/env.ts");
const { resolveConfig, envConfigFile } = await import("../src/config.ts");
const { isolateLoginFile } = await import("../src/paths.ts");

/** Write a per-env config layer without syncing. */
function writeConfig(dir: string, yaml: string): void {
  const f = envConfigFile(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, yaml);
}

describe("login.isolate 解析", () => {
  test("默认没有任何环境隔离登录", () => {
    const dir = createEnv("plain");
    expect(resolveConfig(dir).isolateLogin).toEqual([]);
  });

  test("认 login.isolate，且 allow 照旧生效", () => {
    const dir = createEnv("both");
    writeConfig(dir, "login:\n  isolate: [claude]\nallow:\n  remove: [.cache]\n");
    const c = resolveConfig(dir);
    expect(c.isolateLogin).toEqual(["claude"]);
    expect(c.allow).not.toContain(".cache");
    expect(c.problems).toEqual([]);
  });

  test("空列表是一个答案，不是没表态", () => {
    // the layering rule: a later layer that says `isolate: []` means shared,
    // and must be able to override a global layer that isolated something
    const dir = createEnv("empty");
    writeConfig(dir, "login:\n  isolate: []\n");
    expect(resolveConfig(dir).isolateLogin).toEqual([]);
  });

  test("不是 agent 的名字被拒绝并报出来", () => {
    const dir = createEnv("bogus");
    writeConfig(dir, "login:\n  isolate: [codex]\n");
    const c = resolveConfig(dir);
    expect(c.isolateLogin).toEqual([]);
    expect(c.problems.some((p) => p.message.includes("not an agent"))).toBe(true);
  });

  test("cursor / kimi 没有可隔离的 per-env 登录，写了就报错而不是静默无效", () => {
    const dir = createEnv("nolever");
    writeConfig(dir, "login:\n  isolate: [cursor, kimi]\n");
    const c = resolveConfig(dir);
    expect(c.isolateLogin).toEqual([]);
    expect(c.problems.filter((p) => p.message.includes("no per-environment login")))
      .toHaveLength(2);
  });

  test("login 下的未知键被报出来", () => {
    const dir = createEnv("unknownkey");
    writeConfig(dir, "login:\n  share: [claude]\n");
    expect(resolveConfig(dir).problems.some((p) => p.message.includes('"login.share"')))
      .toBe(true);
  });
});

describe("标记文件跟着配置走", () => {
  test("配置里加了就落盘，去掉了就清掉", () => {
    const dir = createEnv("markers");
    const marker = isolateLoginFile(dir, "claude");
    expect(fs.existsSync(marker)).toBe(false);

    writeConfig(dir, "login:\n  isolate: [claude]\n");
    ensureSkeleton(dir);
    expect(fs.existsSync(marker)).toBe(true);

    // config is the source of truth in both directions: dropping the agent has
    // to remove the marker, or the env keeps demanding its own login with
    // nothing left on disk explaining why
    writeConfig(dir, "login:\n  isolate: []\n");
    ensureSkeleton(dir);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("现有环境不需要迁移：没有标记就等于共享", () => {
    // the polarity that makes this true — an env created before login sharing
    // existed has no marker, and absence means shared
    const dir = createEnv("legacy");
    fs.rmSync(isolateLoginFile(dir, "claude"), { force: true });
    ensureSkeleton(dir);
    expect(fs.existsSync(isolateLoginFile(dir, "claude"))).toBe(false);
  });
});
