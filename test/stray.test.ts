import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStrayLinks, healStrayLinks, repairStrayLink } from "../src/stray.ts";

let tmp: string;
let home: string;
let envs: string;
let prevHome: string | undefined;
let prevState: string | undefined;

/**
 * A fixture home rather than the real one, installed as TREAD_HOME because
 * that is what `realHome()` prefers — the same reason `env.test.ts` does it.
 * These tests create broken symlinks on purpose, which is not something to do
 * anywhere near a real `~/.local/bin`.
 */
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-stray-"));
  home = path.join(tmp, "home");
  envs = path.join(tmp, "state", "envs");
  prevHome = process.env.TREAD_HOME;
  prevState = process.env.TREAD_STATE_DIR;
  process.env.TREAD_HOME = home;
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".local/share"), { recursive: true });
  fs.mkdirSync(envs, { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.TREAD_HOME;
  else process.env.TREAD_HOME = prevHome;
  if (prevState === undefined) delete process.env.TREAD_STATE_DIR;
  else process.env.TREAD_STATE_DIR = prevState;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An environment that shares the way a real one does: whole-directory links back out. */
function makeEnv(name: string, shared = [".local/bin", ".local/share"]): string {
  const root = path.join(envs, name);
  fs.mkdirSync(path.join(root, ".tread"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".tread/sync.json"),
    JSON.stringify({ version: 1, paths: shared }),
  );
  for (const rel of shared) {
    const link = path.join(root, rel);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(home, rel), link);
  }
  return root;
}

function touch(p: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  return p;
}

function link(target: string, at: string): string {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
  return at;
}

const VERSION = ".local/share/claude/versions/2.1.229";

/** What claude's updater leaves behind when it runs with HOME on an environment. */
function breakLauncher(envRoot: string, rel = VERSION): { launcher: string; real: string } {
  const real = touch(path.join(home, rel));
  const launcher = link(path.join(envRoot, rel), path.join(home, ".local/bin/claude"));
  return { launcher, real };
}

describe("findStrayLinks", () => {
  test("没有指向环境的软链时报干净", () => {
    makeEnv("base");
    touch(path.join(home, ".local/bin/git"));
    expect(findStrayLinks()).toEqual({ found: [], truncated: false });
  });

  test("指向真 home 内部的普通软链不算越界", () => {
    makeEnv("base");
    link(touch(path.join(home, ".local/share/foo")), path.join(home, ".local/bin/foo"));
    expect(findStrayLinks().found).toEqual([]);
  });

  test("环境内自更新写坏的 launcher 会被找到，并算出真 home 里的修复目标", () => {
    const root = makeEnv("base");
    const { launcher, real } = breakLauncher(root);
    const { found, truncated } = findStrayLinks();
    expect(truncated).toBe(false);
    expect(found).toHaveLength(1);
    expect(found[0]!.link).toBe(launcher);
    expect(found[0]!.env).toBe("base");
    expect(found[0]!.repair).toBe(real);
    // the environment is still there, so it resolves — nothing looks wrong yet
    expect(found[0]!.dangling).toBe(false);
  });

  test("环境已删后链接悬空，但仍能修回真 home", () => {
    const root = makeEnv("gone");
    const { real } = breakLauncher(root);
    fs.rmSync(root, { recursive: true, force: true });
    const { found } = findStrayLinks();
    expect(found).toHaveLength(1);
    expect(found[0]!.dangling).toBe(true);
    // the starting points survive the environment that named them, or this
    // check would go quiet exactly when there is something to find
    expect(found[0]!.repair).toBe(real);
  });

  test("真 home 里没有对应物时只报告，不猜一个目标", () => {
    const root = makeEnv("base");
    link(path.join(root, VERSION), path.join(home, ".local/bin/claude"));
    const { found } = findStrayLinks();
    expect(found).toHaveLength(1);
    expect(found[0]!.repair).toBeNull();
  });

  test("指向环境隔离目录的软链不映射，哪怕真 home 里恰好有同名文件", () => {
    const root = makeEnv("base");
    touch(path.join(home, ".claude/skills/x/SKILL.md"));
    link(path.join(root, ".claude/skills/x/SKILL.md"), path.join(home, ".local/bin/x"));
    const { found } = findStrayLinks();
    expect(found).toHaveLength(1);
    expect(found[0]!.env).toBe("base");
    // `.claude` is isolated, so no write inside the env could have produced
    // this out here — tread did not cause it and must not redirect it
    expect(found[0]!.repair).toBeNull();
  });

  test("指向环境根目录的软链是用户自己的快捷方式，只报告", () => {
    const root = makeEnv("base");
    link(root, path.join(home, ".local/bin/base"));
    const { found } = findStrayLinks();
    expect(found).toHaveLength(1);
    expect(found[0]!.repair).toBeNull();
  });

  test("相对路径的软链也按链接所在目录解析出来", () => {
    const root = makeEnv("base");
    const real = touch(path.join(home, VERSION));
    const at = path.join(home, ".local/bin/claude");
    fs.symlinkSync(path.relative(path.dirname(at), path.join(root, VERSION)), at);
    const { found } = findStrayLinks();
    expect(found).toHaveLength(1);
    expect(found[0]!.repair).toBe(real);
  });

  test("超过深度上限的软链不找，抬高上限就能找到", () => {
    const root = makeEnv("base");
    touch(path.join(home, VERSION));
    link(path.join(root, VERSION), path.join(home, ".local/share/a/b/c/claude"));
    expect(findStrayLinks().found).toEqual([]);
    expect(findStrayLinks({ maxDepth: 5 }).found).toHaveLength(1);
  });

  test("软链成环不会走不完", () => {
    makeEnv("base");
    link(path.join(home, ".local/share"), path.join(home, ".local/share/loop"));
    const { found, truncated } = findStrayLinks();
    expect(found).toEqual([]);
    expect(truncated).toBe(false);
  });

  test("预算耗尽时说自己没查全，而不是报干净", () => {
    const root = makeEnv("base");
    breakLauncher(root);
    for (let i = 0; i < 5; i++) touch(path.join(home, `.local/share/pad${i}`));
    expect(findStrayLinks({ direntBudget: 1 }).truncated).toBe(true);
    expect(findStrayLinks({ timeBudgetMs: -1 }).truncated).toBe(true);
  });

  test("一个环境都不剩时仍然用默认共享列表作为起点", () => {
    const root = makeEnv("only");
    const { real } = breakLauncher(root);
    fs.rmSync(envs, { recursive: true, force: true });
    expect(findStrayLinks().found[0]!.repair).toBe(real);
  });
});

describe("repairStrayLink", () => {
  test("修完之后指向真 home，环境删掉也还在", () => {
    const root = makeEnv("base");
    const { launcher, real } = breakLauncher(root);
    const [stray] = findStrayLinks().found;
    expect(repairStrayLink(stray!)).toBe(true);
    expect(fs.realpathSync(launcher)).toBe(fs.realpathSync(real));
    fs.rmSync(root, { recursive: true, force: true });
    expect(fs.existsSync(launcher)).toBe(true);
    expect(findStrayLinks().found).toEqual([]);
  });

  test("重复修是幂等的", () => {
    const root = makeEnv("base");
    const { launcher, real } = breakLauncher(root);
    const [stray] = findStrayLinks().found;
    expect(repairStrayLink(stray!)).toBe(true);
    expect(repairStrayLink(stray!)).toBe(true);
    expect(fs.readlinkSync(launcher)).toBe(real);
  });

  test("修不了的不动它", () => {
    const root = makeEnv("base");
    const at = link(path.join(root, VERSION), path.join(home, ".local/bin/claude"));
    const [stray] = findStrayLinks().found;
    expect(repairStrayLink(stray!)).toBe(false);
    expect(fs.readlinkSync(at)).toBe(path.join(root, VERSION));
  });
});

describe("healStrayLinks", () => {
  test("能修的修掉，不能修的留在 stuck 里", () => {
    const root = makeEnv("base");
    breakLauncher(root);
    link(root, path.join(home, ".local/bin/base"));
    const { repaired, stuck, truncated } = healStrayLinks();
    expect(truncated).toBe(false);
    expect(repaired.map((s) => path.basename(s.link))).toEqual(["claude"]);
    expect(stuck.map((s) => path.basename(s.link))).toEqual(["base"]);
    // the repairable one is gone for good; the other is still reported
    expect(healStrayLinks().repaired).toEqual([]);
    expect(healStrayLinks().stuck).toHaveLength(1);
  });
});
