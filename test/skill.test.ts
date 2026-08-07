import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-skill-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_ENV;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { installTreadSkill, treadSkillBody } = await import("../src/skill.ts");
const { createEnv } = await import("../src/env.ts");
const { skillsDir } = await import("../src/paths.ts");
const { readSkills } = await import("../src/inspect/skills.ts");
const { VERSION } = await import("../src/version.ts");
const BODY = treadSkillBody();

const AGENTS = ["claude", "cursor", "kimi"] as const;

describe("bundled tread skill", () => {
  test("create 就把 skill 装进三个 agent 的 skills 目录", () => {
    const dir = createEnv("guide");
    for (const a of AGENTS) {
      const f = path.join(skillsDir(dir, a), "tread", "SKILL.md");
      expect(fs.existsSync(f)).toBe(true);
      expect(fs.readFileSync(f, "utf8")).toBe(BODY);
    }
  });

  test("每个 agent 自己的 inspect 层都能发现它", () => {
    const dir = path.join(tmp, "state", "envs", "guide");
    for (const a of AGENTS) {
      expect(readSkills(dir, a).map((s) => s.name)).toContain("tread");
    }
  });

  test("frontmatter 有 name/version/description，version 与 CLI 对齐", () => {
    const [, front] = BODY.split("---");
    expect(front).toContain("name: tread");
    expect(front).toContain(`version: ${VERSION}`);
    // the agent needs to reach for this when HOME looks wrong, not only when
    // the user says the word "tread"
    expect(front).toMatch(/TREAD_ENV/);
    expect(front).toMatch(/config or credential/);
  });

  test("inspect 层读到的版本就是 CLI 的版本", () => {
    const dir = path.join(tmp, "state", "envs", "guide");
    const s = readSkills(dir, "claude").find((x) => x.name === "tread");
    expect(s?.version).toBe(VERSION);
  });

  test("覆盖到关键事实：HOME 被移动、真 home 是 TREAD_HOME、tread 不装东西", () => {
    expect(BODY).toContain("`$HOME` is the environment");
    expect(BODY).toContain("The user's real home is `$TREAD_HOME`");
    expect(BODY).toContain("tread never installs anything itself");
  });

  test("配置部分是可执行的：症状、改哪个文件、写什么", () => {
    // the point of the rewrite: an agent should not have to understand the
    // policy engine, only which symptom maps to which edit
    expect(BODY).toContain("$TREAD_ENV_DIR/.tread/config.yaml");
    expect(BODY).toContain("$TREAD_HOME/.config/tread/config.yaml");
    expect(BODY).toContain("extra: [.foo]");
    expect(BODY).toContain("remove: [.cache]");
    expect(BODY).toContain("tread doctor --fix");
    // and it must not leak the internals it used to explain
    for (const leak of ["policy tree", "hard deny", "manifest", "mirror", "three layer"]) {
      expect(BODY.toLowerCase()).not.toContain(leak);
    }
  });

  test("命令表面全覆盖：帮助里的每个命令都被提到", async () => {
    const help = (await import("../src/commands.ts")) as unknown;
    // derive from the CLI itself so a new command cannot slip past the guide
    let text = "";
    await (help as { runCommand: (a: string[], o: (s: string) => void) => Promise<number> })
      .runCommand(["help"], (s) => { text += s; });
    const commands = [...text.matchAll(/^ {2}(\w[\w-]*)/gm)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThan(10);
    for (const c of commands) {
      expect(BODY).toContain(`tread ${c}`);
    }
  });

  test("幂等：内容没变就不重写", () => {
    const dir = path.join(tmp, "state", "envs", "guide");
    expect(installTreadSkill(dir)).toEqual([]);
  });

  test("被改坏了会被改回来", () => {
    const dir = path.join(tmp, "state", "envs", "guide");
    const f = path.join(skillsDir(dir, "claude"), "tread", "SKILL.md");
    fs.writeFileSync(f, "clobbered");
    expect(installTreadSkill(dir)).toEqual(["claude"]);
    expect(fs.readFileSync(f, "utf8")).toBe(BODY);
  });
});
