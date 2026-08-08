import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-cmd-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  process.env.TREAD_DATA_DIR = path.join(tmp, "share");
  delete process.env.TREAD_ENV;
  delete process.env.TREAD_SHELL;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { runCommand, HELP } = await import("../src/commands.ts");
const { COMMANDS, renderCandidate } = await import("../src/completion.ts");
const { completionFile } = await import("../src/paths.ts");

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

  test("doctor 报告被遗弃的 sync 锁，--fix 清掉它", async () => {
    const lock = path.join(tmp, "state/envs/other/.tread/sync.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const dead = () =>
      fs.writeFileSync(
        lock,
        JSON.stringify({ pid: 999_999, host: os.hostname(), at: Date.now() }),
      );

    dead();
    const { out } = await run(["doctor", "other"]);
    expect(out).toContain("sync.lock");
    // reporting only: a plain doctor never writes
    expect(fs.existsSync(lock)).toBe(true);

    dead();
    await run(["doctor", "other", "--fix"]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("doctor 不碰活着的锁", async () => {
    const lock = path.join(tmp, "state/envs/other/.tread/sync.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() }),
    );
    const prev = process.env.TREAD_LOCK_TIMEOUT_MS;
    process.env.TREAD_LOCK_TIMEOUT_MS = "200";
    try {
      const { out } = await run(["doctor", "other"]);
      expect(out).not.toContain("sync.lock");
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      process.env.TREAD_LOCK_TIMEOUT_MS = prev;
      fs.rmSync(lock, { force: true });
    }
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

  test("cp 的表就是 status 的表，外加一行拷贝摘要", async () => {
    const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    await run(["create", "orig"]);
    const r = await run(["cp", "orig", "clone"]);
    expect(r.code).toBe(0);
    expect(plain(r.out)).toContain("copied  orig → clone");
    // the same renderer, so the copy cannot describe the new env differently
    // from the command whose whole job is describing it
    const status = await run(["status", "clone"]);
    expect(plain(r.out)).toContain(plain(status.out).trimEnd());
    expect(plain(r.out)).toMatch(/skipped sessions and caches · \d+ paths? rewritten/);
  });

  test("cp 要两个名字，一个不算", async () => {
    const r = await run(["cp", "orig"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("tread cp <src> <dst>");
  });

  test("cp 到已存在的名字是错误，不是静默合并", async () => {
    const r = await run(["cp", "orig", "clone"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("already exists");
  });

  test("help 里有 cp", async () => {
    expect((await run(["help"])).out).toContain("cp <src> <dst>");
  });
});

describe("_complete", () => {
  beforeAll(() => {
    // its own environment, built by hand rather than through `tread create`:
    // that installs the bundled "tread" guide skill into every agent, which
    // would show up as a stray candidate alongside the one this fixture is
    // actually about. A hand-built tree has exactly what is written below,
    // with no dependency on what describe("commands") did to "work" earlier
    // in this file.
    const root = path.join(tmp, "state/envs/complete-target");
    const skill = path.join(root, ".claude/skills/lark-mail");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: lark-mail\ndescription: \"飞书邮箱\"\n---\nbody\n",
    );
    fs.writeFileSync(
      path.join(root, ".claude/.mcp.json"),
      JSON.stringify({ mcpServers: { context7: { command: "npx", args: [] } } }),
    );
  });

  test("commands 列出子命令，且不吐隐藏的那两个", async () => {
    const { code, out } = await run(["_complete", "commands"]);
    expect(code).toBe(0);
    const names = out.trim().split("\n").map((l) => l.split(":")[0]);
    expect(names).toContain("use");
    expect(names).toContain("doctor");
    expect(names).not.toContain("_export");
    expect(names).not.toContain("_complete");
  });

  test("COMMANDS 与 HELP 不会各说各话", () => {
    for (const c of COMMANDS) {
      expect(HELP).toContain(`  ${c.value} `);
    }
  });

  test("envs 列出环境，激活的那个标 active", async () => {
    process.env.TREAD_ENV = "work";
    try {
      const { out } = await run(["_complete", "envs"]);
      expect(out).toContain("work:active");
      expect(out).toMatch(/^other$/m);
    } finally {
      delete process.env.TREAD_ENV;
    }
  });

  test("shells 出四个", async () => {
    const { out } = await run(["_complete", "shells"]);
    expect(out.trim().split("\n").sort()).toEqual(["bash", "fish", "starship", "zsh"]);
  });

  test("targets 第一格给环境名和 agent 名，不给 skill 名", async () => {
    const { out } = await run(["_complete", "targets", "skills"]);
    const names = out.trim().split("\n").map((l) => l.split(":")[0]);
    expect(names).toContain("work");
    expect(names).toContain("claude");
    expect(names).not.toContain("lark-mail");
  });

  test("targets 第二格同时给 agent 名和 skill 名，因为两者都可能", async () => {
    const { out } = await run(["_complete", "targets", "skills", "complete-target"]);
    const names = out.trim().split("\n").map((l) => l.split(":")[0]);
    expect(names).toContain("kimi");
    expect(names).toContain("lark-mail");
    expect(names).not.toContain("complete-target");
  });

  test("targets 给全 env 和 agent 后只剩 item 名", async () => {
    const { out } = await run(["_complete", "targets", "skills", "complete-target", "claude"]);
    expect(out.trim().split("\n").map((l) => l.split(":")[0])).toEqual(["lark-mail"]);
  });

  test("targets 三格填满后不再给候选", async () => {
    const { out } = await run([
      "_complete", "targets", "skills", "complete-target", "claude", "lark-mail",
    ]);
    expect(out).toBe("");
  });

  test("mcp 的名字来自 .mcp.json，纯 zsh 拿不到的那类", async () => {
    const { out } = await run(["_complete", "targets", "mcp", "complete-target", "claude"]);
    expect(out).toContain("context7");
  });

  test("path 的末格是类别，且要等 agent 定下来才出", async () => {
    const two = await run(["_complete", "targets", "path", "work"]);
    expect(two.out).not.toContain("plugins");
    const three = await run(["_complete", "targets", "path", "work", "claude"]);
    expect(three.out.trim().split("\n")).toEqual(["skills", "plugins", "mcp", "hooks"]);
  });

  test("没指定环境又没有激活环境时，输出空而不是报错文本", async () => {
    delete process.env.TREAD_ENV;
    const { code, out } = await run(["_complete", "targets", "skills", "claude"]);
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("未知请求安静退 1，stdout 一个字都不写", async () => {
    const { code, out } = await run(["_complete", "bogus"]);
    expect(code).toBe(1);
    expect(out).toBe("");
  });

  // 两条都直接打在 renderCandidate 上。走不了 fixture：skill 的 frontmatter
  // 解析器是逐行的，描述里塞不进换行；而带冒号的目录名在 macOS 上不可靠。
  test("值里的冒号要转义，否则 _describe 会把候选拦腰截断", () => {
    expect(renderCandidate({ value: "a:b" })).toBe("a\\:b");
    expect(renderCandidate({ value: "a:b", description: "d" })).toBe("a\\:b:d");
  });

  test("描述里的换行被压平，否则一条候选会裂成好几条", () => {
    expect(renderCandidate({ value: "x", description: " one\ntwo \n" })).toBe("x:one two");
    expect(renderCandidate({ value: "x", description: "" })).toBe("x");
  });
});

describe("init --write 装补全", () => {
  // init --write appends to the rc file, which rcFile() derives from
  // realHome() — point it somewhere disposable before letting this near a
  // real ~/.zshrc. TREAD_HOME is the override realHome() was built to honor
  // (src/paths.ts), the same idiom stateDir()/dataDir() already use elsewhere
  // in this file, so no monkeypatching of a node:os builtin is needed.
  const prevTreadHome = process.env.TREAD_HOME;
  beforeAll(() => {
    process.env.TREAD_HOME = path.join(tmp, "fakehome");
    fs.mkdirSync(process.env.TREAD_HOME, { recursive: true });
  });
  afterAll(() => {
    if (prevTreadHome === undefined) delete process.env.TREAD_HOME;
    else process.env.TREAD_HOME = prevTreadHome;
  });

  test("zsh 第一次是 written，第二次是 rewritten", async () => {
    let err = "";
    const first = await runCommand(["init", "zsh", "--write"], () => {}, (s) => {
      err += s;
    });
    expect(first).toBe(0);
    expect(err).toContain("completion written to");
    expect(fs.existsSync(completionFile())).toBe(true);

    err = "";
    await runCommand(["init", "zsh", "--write"], () => {}, (s) => {
      err += s;
    });
    expect(err).toContain("completion rewritten at");
  });

  test("被手改过的补全，--write 无条件盖回去", async () => {
    fs.appendFileSync(completionFile(), "# hand-edited\n");
    await runCommand(["init", "zsh", "--write"], () => {}, () => {});
    expect(fs.readFileSync(completionFile(), "utf8")).not.toContain("hand-edited");
  });

  test("bash 的 --write 不碰补全", async () => {
    fs.rmSync(completionFile(), { force: true });
    let err = "";
    await runCommand(["init", "bash", "--write"], () => {}, (s) => {
      err += s;
    });
    expect(err).not.toContain("completion");
    expect(fs.existsSync(completionFile())).toBe(false);
  });
});
