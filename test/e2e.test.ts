import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let state: string;
const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-e2e-"));
  state = path.join(tmp, "state");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function tread(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, TREAD_STATE_DIR: state, NO_COLOR: "1", TREAD_ENV: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, code };
}

describe("e2e", () => {
  test("create -> 装一个 skill -> 读得到 -> 删除", async () => {
    expect((await tread(["create", "e2e"])).code).toBe(0);

    const root = path.join(state, "envs", "e2e");
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".cursor"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".kimi-code/config.toml"))).toBe(true);

    // simulate any installer dropping a skill into the environment
    const sd = path.join(root, ".claude/skills/demo");
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(
      path.join(sd, "SKILL.md"),
      "---\nname: demo\nversion: 2.0.0\ndescription: a demo\n---\n",
    );

    const list = await tread(["skills", "e2e", "claude"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("demo");
    expect(list.out).toContain("2.0.0");

    const st = await tread(["status", "e2e"]);
    expect(st.out).toMatch(/claude\s+1\b/);

    const p = await tread(["path", "e2e", "claude", "skills"]);
    expect(p.out.trim()).toBe(path.join(root, ".claude/skills"));

    expect((await tread(["rm", "e2e", "--force"])).code).toBe(0);
    expect(fs.existsSync(root)).toBe(false);
  }, 30000);

  test("exec 透传退出码", async () => {
    await tread(["create", "x"]);
    expect((await tread(["exec", "x", "--", "false"])).code).toBe(1);
    expect((await tread(["exec", "x", "--", "true"])).code).toBe(0);
  }, 30000);

  test("exec 注入隔离变量", async () => {
    const r = await tread(["exec", "x", "--", "sh", "-c", "echo $CLAUDE_CONFIG_DIR"]);
    expect(r.out.trim()).toBe(path.join(state, "envs/x/.claude"));
  }, 20000);

  test("exec 默认不改 HOME，--home 才改", async () => {
    const a = await tread(["exec", "x", "--", "sh", "-c", "echo $HOME"]);
    expect(a.out.trim()).toBe(process.env.HOME ?? os.homedir());
    const b = await tread(["exec", "x", "--home", "--", "sh", "-c", "echo $HOME"]);
    expect(b.out.trim()).toBe(path.join(state, "envs/x"));
  }, 20000);

  test("ls 在非 TTY 下自动退回纯文本", async () => {
    const r = await tread(["ls"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("x");
    expect(r.out).not.toContain("\x1b[");
  }, 20000);

  test("show 在非 TTY 下给概览而不是倾倒全部内容", async () => {
    const r = await tread(["show", "x"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skills");
    expect(r.out).toContain("tread skills x claude");
    expect(r.out.split("\n").length).toBeLessThan(20);
  }, 20000);

  test("init zsh 产出的片段是合法 shell 且定义了 tread()", async () => {
    const r = await tread(["init", "zsh"]);
    const f = path.join(tmp, "init.zsh");
    fs.writeFileSync(f, r.out);
    const check = Bun.spawn(["zsh", "-n", f], { stdout: "pipe", stderr: "pipe" });
    expect(await check.exited).toBe(0);
  }, 20000);

  test("init fish 产出的片段语法合法", async () => {
    const hasFish = Bun.which("fish");
    if (!hasFish) return;
    const r = await tread(["init", "fish"]);
    const f = path.join(tmp, "init.fish");
    fs.writeFileSync(f, r.out);
    const check = Bun.spawn(["fish", "-n", f], { stdout: "pipe", stderr: "pipe" });
    expect(await check.exited).toBe(0);
  }, 20000);

  test("激活链路：eval init + tread use 之后 agent 变量已就位", async () => {
    const init = (await tread(["init", "zsh"])).out;
    const script = path.join(tmp, "flow.zsh");
    fs.writeFileSync(
      script,
      `${init}\n` +
        `tread() { case "$1" in use|deactivate) eval "$(bun run ${CLI} _export "$@")";; *) bun run ${CLI} "$@";; esac }\n` +
        `tread use x\n` +
        `echo "ENV=$TREAD_ENV"\n` +
        `echo "CLAUDE=$CLAUDE_CONFIG_DIR"\n` +
        `echo "CURSOR=$CURSOR_CONFIG_DIR"\n` +
        `echo "KIMI=$KIMI_CODE_HOME"\n` +
        `tread deactivate\n` +
        `echo "AFTER=[$TREAD_ENV][$CLAUDE_CONFIG_DIR]"\n`,
    );
    const p = Bun.spawn(["zsh", script], {
      env: { ...process.env, TREAD_STATE_DIR: state, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain("ENV=x");
    expect(out).toContain(`CLAUDE=${path.join(state, "envs/x/.claude")}`);
    expect(out).toContain(`CURSOR=${path.join(state, "envs/x/.cursor")}`);
    expect(out).toContain(`KIMI=${path.join(state, "envs/x/.kimi-code")}`);
    expect(out).toContain("AFTER=[][]");
  }, 30000);
});
