import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
    // demo plus the guide tread installs into every environment
    expect(st.out).toMatch(/claude\s+2\b/);

    const p = await tread(["path", "e2e", "claude", "skills"]);
    expect(p.out.trim()).toBe(path.join(root, ".claude/skills"));

    expect((await tread(["rm", "e2e", "--force"])).code).toBe(0);
    expect(fs.existsSync(root)).toBe(false);
  }, 30000);

  test("cp 出来的环境立刻能用，且与源环境无关", async () => {
    await tread(["create", "cp-src"]);
    const src = path.join(state, "envs", "cp-src");
    const sd = path.join(src, ".claude/skills/demo");
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(
      path.join(sd, "SKILL.md"),
      `---\nname: demo\ndescription: d\n---\ninstalled under ${src}\n`,
    );

    const cp = await tread(["cp", "cp-src", "cp-dst"]);
    expect(cp.code).toBe(0);
    expect(cp.out).toContain("copied  cp-src → cp-dst");

    // the copy prints the very table `status` would, so they must agree
    const status = await tread(["status", "cp-dst"]);
    expect(cp.out).toContain(status.out.trimEnd());
    expect((await tread(["ls", "--plain"])).out).toContain("cp-dst");

    const dst = path.join(state, "envs", "cp-dst");
    const copied = fs.readFileSync(path.join(dst, ".claude/skills/demo/SKILL.md"), "utf8");
    expect(copied).toContain(`installed under ${dst}`);
    expect(copied).not.toContain(src);

    // a second copy onto the same name is an error, not a silent merge
    expect((await tread(["cp", "cp-src", "cp-dst"])).code).toBe(1);
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

  test("use 一个不存在的环境：直报错，绝不把错误文本 eval 进 shell", async () => {
    const init = (await tread(["init", "zsh"])).out;
    const script = path.join(tmp, "bad.zsh");
    fs.writeFileSync(
      script,
      `${init}\n` +
        `tread() { case "$1" in use|deactivate) local __o; __o=$(bun run ${CLI} _export "$@") || return $?; eval "$__o";; *) bun run ${CLI} "$@";; esac }\n` +
        `tread use nope\n` +
        `echo "code=$?"\n`,
    );
    const p = Bun.spawn(["zsh", script], {
      env: { ...process.env, TREAD_STATE_DIR: state, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    await p.exited;
    expect(err).toContain('no environment named "nope"');
    expect(out).toContain("code=1");
    // the old bug: the error text reached eval and zsh tried to run it
    expect(err).not.toContain("command not found");
    expect(err).not.toContain("no matches found");
  }, 30000);

  test("激活把 shim 目录放到 PATH 最前，deactivate 精确摘除", async () => {
    const init = (await tread(["init", "zsh"])).out;
    const script = path.join(tmp, "shimpath.zsh");
    fs.writeFileSync(
      script,
      `${init}\n` +
        `tread() { case "$1" in use|deactivate) local __o; __o=$(bun run ${CLI} _export "$@") || return $?; eval "$__o";; *) bun run ${CLI} "$@";; esac }\n` +
        `before=$PATH\n` +
        `tread use x\n` +
        `echo "FIRST=\${PATH%%:*}"\n` +
        `command -v cursor-agent | sed 's/^/WHICH=/'\n` +
        `tread deactivate\n` +
        `[ "$PATH" = "$before" ] && echo "RESTORED=yes" || echo "RESTORED=no"\n`,
    );
    const p = Bun.spawn(["zsh", script], {
      env: { ...process.env, TREAD_STATE_DIR: state, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain(`FIRST=${path.join(state, "shims")}`);
    // typing the agent's own name must land on the shim while active
    expect(out).toContain(`WHICH=${path.join(state, "shims", "cursor-agent")}`);
    expect(out).toContain("RESTORED=yes");
  }, 30000);

  test("shim 对每个 agent 及别名都存在，且都把 HOME 指向环境", async () => {
    await tread(["_export", "use", "x"]);
    const dir = path.join(state, "shims");
    const home = (n: string) =>
      fs.readFileSync(path.join(dir, n), "utf8").includes('HOME="$TREAD_ENV_DIR"');
    for (const n of ["claude", "cursor-agent", "agent", "kimi"]) {
      expect(fs.existsSync(path.join(dir, n))).toBe(true);
      expect(home(n)).toBe(true);
    }
  }, 20000);

  test("use / deactivate 成功时在 stderr 上给出提示", async () => {
    const a = await tread(["_export", "use", "x"]);
    expect(a.err).toContain("tread: x");
    expect(a.out).toContain("export TREAD_ENV=");
    const b = await tread(["_export", "deactivate"]);
    expect(b.err).toContain("tread: deactivated");
  }, 20000);

  // The bug this reproduces, end to end: claude updating itself inside an
  // environment rewrites `$HOME/.local/bin/claude`, which is the user's real
  // launcher because `.local/bin` is shared as a whole directory, and points
  // it at a path under the environment. Deleting the environment then leaves
  // the real home with a dangling launcher — `command not found: claude`
  // outside every environment, with the binary still sitting there untouched.
  test("环境内写坏的 launcher 在 rm 之后仍然可用", async () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-stray-"));
    const opts = { HOME: home, TREAD_HOME: home };
    for (const rel of [".local/bin", ".local/share"]) {
      fs.mkdirSync(path.join(home, rel), { recursive: true });
    }
    expect((await tread(["create", "doomed"], opts)).code).toBe(0);

    const rel = ".local/share/claude/versions/1.2.3";
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), "binary");
    const launcher = path.join(home, ".local/bin/claude");
    fs.symlinkSync(path.join(state, "envs/doomed", rel), launcher);
    // resolves through the shared link, so nothing looks wrong yet
    expect(fs.existsSync(launcher)).toBe(true);

    const r = await tread(["rm", "doomed", "--force"], opts);
    expect(r.code).toBe(0);
    expect(r.out).toContain("repaired");
    expect(fs.existsSync(path.join(state, "envs/doomed"))).toBe(false);
    expect(fs.existsSync(launcher)).toBe(true);
    expect(fs.readlinkSync(launcher)).toBe(path.join(home, rel));
  }, 20000);

  // 光追加 [env_var.tread] 表，对写了显式 format 的配置等于什么都没做：
  // starship 只渲染顶层 format 点名的模块
  describe("init starship --write", () => {
    const CONFIG = 'format = """\n[](red)\\\n$directory\\\n$character"""\n';
    let home: string;
    let cfg: string;

    // TREAD_HOME as well as HOME: rcFile() routes through realHome(), which
    // prefers TREAD_HOME so that an agent shelling out to tread cannot
    // misdirect --write into the environment its shim moved HOME to. Inherit
    // that from a test runner started inside an environment and this writes
    // the user's actual starship.toml instead of the fixture.
    const write = () =>
      tread(["init", "starship", "--write"], { HOME: home, TREAD_HOME: home });
    const read = () => fs.readFileSync(cfg, "utf8");

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(tmp, "home-"));
      cfg = path.join(home, ".config/starship.toml");
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, CONFIG);
    });

    test("既追加模块，也把它接进 format", async () => {
      expect((await write()).code).toBe(0);
      expect(read()).toContain("[env_var.tread]");
      expect(read()).toContain('format = """\n${env_var.tread}\\\n[](red)\\\n');
    });

    test("写进文件的块不带复制粘贴用的说明文字", async () => {
      await write();
      expect(read()).not.toContain("add to ~/.config/starship.toml");
      expect(read()).not.toContain("then place");
    });

    test("重复执行不叠加", async () => {
      await write();
      const first = read();
      await write();
      expect(read()).toBe(first);
    });

    test("块已存在但 format 漏了时仍然补上", async () => {
      // 老版本 --write 留下的状态：模块在，prompt 却一直不显示
      fs.writeFileSync(cfg, CONFIG + "\n# >>> tread >>>\n[env_var.tread]\n# <<< tread <<<\n");
      await write();
      expect(read()).toContain("${env_var.tread}\\\n[](red)");
    });

    test("不建议 source 一个 TOML 文件", async () => {
      const r = await write();
      expect(r.err).not.toContain("source ");
      expect(r.err).toContain("starship.toml");
    });

    test("没有顶层 format 时只追加模块", async () => {
      fs.writeFileSync(cfg, '[directory]\nformat = "[ $path ]($style)"\n');
      await write();
      expect(read()).toContain("[env_var.tread]");
      expect(read()).toContain('[directory]\nformat = "[ $path ]($style)"');
    });
  });
});

describe("并发", () => {
  test("多个进程同时激活不同 env：时间戳一个都不丢", async () => {
    const names = ["par-a", "par-b", "par-c", "par-d", "par-e"];
    for (const n of names) expect((await tread(["create", n])).code).toBe(0);

    // genuinely concurrent, not a loop — this is the shape that lost writes
    const runs = await Promise.all(names.map((n) => tread(["_export", "use", n])));
    for (const r of runs) expect(r.code).toBe(0);

    for (const n of names) {
      expect(fs.existsSync(path.join(state, "envs", n, ".tread/last-used"))).toBe(true);
    }
    // every one of them kept its timestamp; before, some would have been lost
    const ls = await tread(["ls"]);
    for (const n of names) {
      expect(ls.out).toMatch(new RegExp(`^\\s*${n}\\s+just now$`, "m"));
    }
  }, 60000);

  test("同一个 env 被并发激活：都成功，不留锁", async () => {
    expect((await tread(["create", "par-same"])).code).toBe(0);
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => tread(["_export", "use", "par-same"])),
    );
    for (const r of runs) expect(r.code).toBe(0);
    expect(
      fs.existsSync(path.join(state, "envs", "par-same", ".tread/sync.lock")),
    ).toBe(false);
  }, 60000);

  test("锁不跨越 exec 的子进程：agent 在跑时别的 shell 照样能激活", async () => {
    expect((await tread(["create", "par-exec"])).code).toBe(0);
    const slow = tread(["exec", "par-exec", "--", "sleep", "3"]);
    await Bun.sleep(800);

    const t = Date.now();
    const other = await tread(["_export", "use", "par-exec"]);
    expect(other.code).toBe(0);
    // if the lock spanned the spawn this would have waited out the timeout
    expect(Date.now() - t).toBeLessThan(2500);
    expect((await slow).code).toBe(0);
  }, 60000);
});
