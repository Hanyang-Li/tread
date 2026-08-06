import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-skills-"));
  const d = path.join(env, ".claude/skills/lark-mail");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "SKILL.md"),
    `---
name: lark-mail
version: 1.0.0
description: "飞书邮箱：写邮件、查邮件"
metadata:
  requires:
    bins: ["lark-cli"]
---
body
`,
  );
  const bare = path.join(env, ".claude/skills/bare");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "SKILL.md"), "no frontmatter here\n");
  fs.mkdirSync(path.join(env, ".claude/skills/empty"), { recursive: true });
  fs.mkdirSync(path.join(env, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(env, ".agents/.skill-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        "lark-mail": {
          source: "open.feishu.cn",
          sourceType: "well-known",
          sourceUrl: "https://open.feishu.cn/.well-known/skills/lark-mail/SKILL.md",
          installedAt: "2026-06-26T10:04:15.422Z",
        },
      },
    }),
  );
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readSkills } = await import("../../src/inspect/skills.ts");

describe("readSkills", () => {
  test("解析 frontmatter 并合并 lock 信息", () => {
    const s = readSkills(env, "claude").find((x) => x.name === "lark-mail")!;
    expect(s.version).toBe("1.0.0");
    expect(s.description).toContain("飞书邮箱");
    expect(s.requiresBins).toEqual(["lark-cli"]);
    expect(s.source).toBe("open.feishu.cn");
    expect(s.installedAt).toBe("2026-06-26T10:04:15.422Z");
  });

  test("没有 frontmatter 的 skill 用目录名兜底，不抛异常", () => {
    const s = readSkills(env, "claude").find((x) => x.name === "bare")!;
    expect(s).toBeDefined();
    expect(s.version).toBeNull();
    expect(s.description).toBeNull();
  });

  test("没有 SKILL.md 的目录被忽略", () => {
    expect(readSkills(env, "claude").some((x) => x.name === "empty")).toBe(false);
  });

  test("目录不存在时返回空数组", () => {
    expect(readSkills("/nonexistent", "kimi")).toEqual([]);
  });

  test("按名字排序", () => {
    expect(readSkills(env, "claude").map((s) => s.name)).toEqual(["bare", "lark-mail"]);
  });
});
