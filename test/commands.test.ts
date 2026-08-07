import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-cmd-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_ENV;
  delete process.env.TREAD_SHELL;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { runCommand } = await import("../src/commands.ts");

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCommand(args, (s) => {
    out += s;
  });
  return { code, out };
}

describe("commands", () => {
  test("create 输出一行路径", async () => {
    const { code, out } = await run(["create", "work"]);
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("created");
    expect(out).toContain("envs/work");
  });

  test("create 重复报错", async () => {
    const { code, out } = await run(["create", "work"]);
    expect(code).toBe(1);
    expect(out).toContain("already exists");
  });

  test("path 的四种参数形态", async () => {
    expect((await run(["path", "work"])).out.trim()).toMatch(/envs\/work$/);
    expect((await run(["path", "work", "claude"])).out.trim()).toMatch(/envs\/work\/\.claude$/);
    expect((await run(["path", "work", "claude", "skills"])).out.trim()).toMatch(
      /envs\/work\/\.claude\/skills$/,
    );
    expect((await run(["path", "work", "kimi", "skills"])).out.trim()).toMatch(
      /envs\/work\/\.agents\/skills$/,
    );
  });

  test("path 输出绝无颜色与多余字符", async () => {
    const { out } = await run(["path", "work"]);
    expect(out).not.toContain("\x1b[");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  test("path 拒绝未知 category", async () => {
    const { code, out } = await run(["path", "work", "claude", "bogus"]);
    expect(code).toBe(1);
    expect(out).toContain("unknown category");
  });

  test("未知环境给出 did-you-mean", async () => {
    const { code, out } = await run(["path", "wrok"]);
    expect(code).toBe(1);
    expect(out).toContain('no environment named "wrok"');
    expect(out).toContain('did you mean "work"');
  });

  test("use 未加载 shell 集成时明确报错", async () => {
    const { code, out } = await run(["use", "work"]);
    expect(code).toBe(1);
    expect(out).toContain("shell integration not loaded");
    expect(out).toContain('eval "$(tread init zsh)"');
  });

  test("_export use 输出 export 行", async () => {
    const { code, out } = await run(["_export", "use", "work"]);
    expect(code).toBe(0);
    expect(out).toContain("export TREAD_ENV='work'");
    expect(out).toContain("export CLAUDE_CONFIG_DIR=");
  });

  test("_export deactivate 输出 unset", async () => {
    expect((await run(["_export", "deactivate"])).out).toContain("unset TREAD_ENV");
  });

  test("status 表头与 agent 行", async () => {
    const { code, out } = await run(["status", "work"]);
    expect(code).toBe(0);
    expect(out).toContain("skills");
    expect(out).toContain("plugins");
    expect(out).toContain("claude");
    expect(out).toContain("not used yet");
  });

  test("status 无参列全部环境", async () => {
    const { out } = await run(["status"]);
    expect(out).toContain("work");
  });

  test("新环境只有 tread 自带的指南，且不报错", async () => {
    const { code, out } = await run(["skills", "work", "claude"]);
    expect(code).toBe(0);
    expect(out).toContain("tread");
    expect(out).toContain("1 skill");
  });

  test("skills 不给 agent 时列出全部三个", async () => {
    const { out } = await run(["skills", "work"]);
    expect(out).toContain("claude");
    expect(out).toContain("cursor");
    expect(out).toContain("kimi");
  });

  test("装一个 skill 后能读出名字与版本", async () => {
    const d = path.join(tmp, "state/envs/work/.claude/skills/demo");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "SKILL.md"),
      "---\nname: demo\nversion: 2.0.0\ndescription: a demo\n---\n",
    );
    const { out } = await run(["skills", "work", "claude"]);
    expect(out).toContain("demo");
    expect(out).toContain("2.0.0");
    // the bundled guide is always there too
    expect(out).toContain("2 skills");
  });

  test("skill 详情页", async () => {
    const { code, out } = await run(["skills", "work", "claude", "demo"]);
    expect(code).toBe(0);
    expect(out).toContain("a demo");
    expect(out).toContain("path");
  });

  test("不存在的 skill 详情报错", async () => {
    const { code, out } = await run(["skills", "work", "claude", "nope"]);
    expect(code).toBe(1);
    expect(out).toContain('no skill "nope"');
  });

  test("init zsh / starship / 未知", async () => {
    expect((await run(["init", "zsh"])).out).toContain("tread()");
    expect((await run(["init", "starship"])).out).toContain("[env_var.tread]");
    expect((await run(["init", "tcsh"])).code).toBe(1);
  });

  test("exec 缺少 -- 报错", async () => {
    const { code, out } = await run(["exec", "work", "echo"]);
    expect(code).toBe(1);
    expect(out).toContain("needs -- before");
  });

  test("rm --force 删除，rm 正在激活的环境被拒", async () => {
    await run(["create", "doomed"]);
    expect((await run(["rm", "doomed", "--force"])).code).toBe(0);
    process.env.TREAD_ENV = "work";
    const r = await run(["rm", "work", "--force"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("currently active");
    delete process.env.TREAD_ENV;
  });

  test("doctor 报告 shell 与 agent 状态", async () => {
    const { code, out } = await run(["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("shell");
    expect(out).toContain("state dir");
    expect(out).toContain("claude");
  });

  test("doctor <env> 仍查公共项，但只查这一个环境", async () => {
    await run(["create", "other"]);
    const { code, out } = await run(["doctor", "work"]);
    expect(code).toBe(0);
    // the shared setup is everyone's, so it is still reported
    expect(out).toContain("shell");
    expect(out).toContain("shims");
    expect(out).toContain("checking work only");
    expect(out).toContain("work");
    expect(out).not.toContain("other");
  });

  test("doctor <env> --fix 与未知环境", async () => {
    expect((await run(["doctor", "work", "--fix"])).code).toBe(0);
    const r = await run(["doctor", "wrok"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no environment named "wrok"');
    // the typo must not have printed a clean-looking report first
    expect(r.out).not.toContain("state dir");
  });

  test("doctor 多环境时 env 级状态同列对齐", async () => {
    const { out } = await run(["doctor"]);
    const lines = out.split("\n").filter((l) => /^(work|other)\s/.test(l));
    expect(lines).toHaveLength(2);
    // names of different length, so only a table can line the statuses up
    const at = lines.map((l) => l.indexOf("ok"));
    expect(at[0]).toBeGreaterThan("other".length);
    expect(at[0]).toBe(at[1]);
  });

  test("doctor 有问题的环境在同一列报计数，--fix 后改口", async () => {
    const dir = path.join(tmp, "state/envs/other/.kimi-code");
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, "credentials");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, "nowhere"), link);

    const { out } = await run(["doctor", "other"]);
    expect(out).toMatch(/^other\s+1 problem$/m);
    expect(out).toContain("broken symlink");

    const fixed = await run(["doctor", "other", "--fix"]);
    expect(fixed.out).toMatch(/^other\s+1 problem fixed$/m);
    expect(fixed.out).toContain("(fixed)");
    // repaired, so the run after it has nothing left to say
    expect((await run(["doctor", "other"])).out).toMatch(/^other\s+ok$/m);
  });

  test("help 与未知命令", async () => {
    expect((await run(["help"])).out).toContain("usage: tread");
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unknown command");
  });

  test("裸 tread 打印 help 但以 1 退出", async () => {
    const { code, out } = await run([]);
    expect(out).toContain("usage: tread");
    expect(code).toBe(1);
    // asking for help explicitly is not an error
    expect((await run(["help"])).code).toBe(0);
  });
});
