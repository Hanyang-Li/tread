import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeLeak } from "../src/leak.ts";

let home: string;
let outside: string;

const mk = (...parts: string[]) => {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const write = (p: string, body = "x") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tread-leak-"));
  home = mk(base, "home");
  outside = mk(base, "elsewhere");
  write(path.join(home, ".claude/skills/leaky/SKILL.md"));
  write(path.join(home, ".claude/agents/leaky.md"));
  write(path.join(home, ".claude/CLAUDE.md"));
  write(path.join(home, ".mcp.json"));
  // reads fine from a project but never from an ancestor, so it must not show up
  write(path.join(home, ".claude/settings.json"));
  mk(home, "plain/deep");
  mk(home, "repo/.git");
  mk(home, "repo/deep");
});

afterAll(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

describe("homeLeak", () => {
  test("真 home 不是祖先时什么都不漏", () => {
    expect(homeLeak(outside, home)).toBeNull();
  });

  test("cwd 在 home 下且中间没有 .git，两族一起漏", () => {
    const leak = homeLeak(path.join(home, "plain/deep"), home)!;
    expect(leak.scope).toBe("all");
    expect(leak.boundary).toBeNull();
    expect(leak.surfaces).toEqual([
      ".claude/skills", ".claude/agents", ".claude/CLAUDE.md", ".mcp.json",
    ]);
  });

  test("中间有 .git 时只剩不受边界约束的那族，且报出是哪一个 .git 挡住的", () => {
    const leak = homeLeak(path.join(home, "repo/deep"), home)!;
    expect(leak.scope).toBe("memory");
    expect(leak.boundary).toBe(path.join(home, "repo"));
    expect(leak.surfaces).toEqual([".claude/CLAUDE.md", ".mcp.json"]);
  });

  test("实测不会从祖先目录漏的东西不进清单", () => {
    const all = homeLeak(path.join(home, "plain/deep"), home)!.surfaces;
    expect(all).not.toContain(".claude/settings.json");
  });

  test("cwd 就是 home 时无从设防，即便 home 自己有 .git", () => {
    const gitHome = mk(path.dirname(home), "githome");
    write(path.join(gitHome, ".claude/CLAUDE.md"));
    mk(gitHome, ".git");
    expect(homeLeak(gitHome, gitHome)!.scope).toBe("all");
  });

  test("只有 home 自己带 .git 时它不构成边界", () => {
    const gitHome = mk(path.dirname(home), "githome2");
    write(path.join(gitHome, ".claude/skills/s/SKILL.md"));
    mk(gitHome, ".git");
    const leak = homeLeak(mk(gitHome, "sub"), gitHome)!;
    expect(leak.scope).toBe("all");
    expect(leak.boundary).toBeNull();
  });

  test("真 home 里没有可漏的东西就不报警", () => {
    const bare = mk(path.dirname(home), "bare");
    expect(homeLeak(mk(bare, "sub"), bare)).toBeNull();
  });

  test("空目录和空文件不算，否则会让人去找一个不存在的泄漏", () => {
    const empty = mk(path.dirname(home), "empty");
    mk(empty, ".claude/skills");
    write(path.join(empty, ".claude/CLAUDE.md"), "");
    expect(homeLeak(mk(empty, "sub"), empty)).toBeNull();
  });
});
