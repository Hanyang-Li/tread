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
  // clawhub writes no lock entry: its provenance lives inside the skill folder
  const claw = path.join(env, ".claude/skills/from-clawhub");
  fs.mkdirSync(path.join(claw, ".clawhub"), { recursive: true });
  fs.writeFileSync(path.join(claw, "SKILL.md"), "---\nname: from-clawhub\n---\nbody\n");
  fs.writeFileSync(
    path.join(claw, ".clawhub/origin.json"),
    JSON.stringify({
      version: 1,
      registry: "https://datalumina.fintopia.tech/cli/clawhub",
      slug: "from-clawhub",
      installedVersion: "1.0.3",
      installedAt: 1786103009270,
      fingerprint: "354b2eb",
    }),
  );
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

  test("clawhub 装的 skill 用 origin.json 补出来源、版本和安装时间", () => {
    const s = readSkills(env, "claude").find((x) => x.name === "from-clawhub")!;
    expect(s.source).toBe("datalumina.fintopia.tech");
    expect(s.registry).toBe("https://datalumina.fintopia.tech/cli/clawhub");
    expect(s.version).toBe("1.0.3");
    expect(s.installedAt).toBe(new Date(1786103009270).toISOString());
  });

  test("lock 里的来源优先于 clawhub，且非 clawhub 的 skill 没有 registry", () => {
    const s = readSkills(env, "claude").find((x) => x.name === "lark-mail")!;
    expect(s.registry).toBeNull();
  });

  test("没有 SKILL.md 的目录被忽略", () => {
    expect(readSkills(env, "claude").some((x) => x.name === "empty")).toBe(false);
  });

  test("目录不存在时返回空数组", () => {
    expect(readSkills("/nonexistent", "kimi")).toEqual([]);
  });

  test("按名字排序", () => {
    expect(readSkills(env, "claude").map((s) => s.name)).toEqual([
      "bare",
      "from-clawhub",
      "lark-mail",
    ]);
  });
});
