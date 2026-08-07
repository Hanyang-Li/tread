import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-copy-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_ENV;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { createEnv, listEnvs } = await import("../src/env.ts");
const { copyEnv, volatilePaths } = await import("../src/copy.ts");
const { envDir, envsDir } = await import("../src/paths.ts");
const { inventory } = await import("../src/inspect/index.ts");

/** A source env holding one of everything the four categories read. */
function seed(root: string): void {
  const w = (rel: string, body: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  // a skill, a plugin whose body lives under plugins/cache, an mcp server, and
  // a hook whose command points back at this env — plus the two `cache`
  // directories that must not share a fate
  w(".claude/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\nbody\n");
  const install = path.join(root, ".claude/plugins/cache/official/feature-dev/1.4.0");
  fs.mkdirSync(path.join(install, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(install, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "feature-dev", description: "f" }),
  );
  w(".claude/plugins/installed_plugins.json", JSON.stringify({
    version: 2,
    plugins: {
      "feature-dev@official": [
        {
          scope: "user", version: "1.4.0", installPath: install,
          installedAt: "2026-04-11T03:46:05.098Z",
        },
      ],
    },
  }));
  w(".claude/plugins/known_marketplaces.json", JSON.stringify({
    official: { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
  }));
  w(".claude/.mcp.json", JSON.stringify({
    mcpServers: { local: { command: "/bin/echo", args: ["hi"] } },
  }));
  w(".claude/settings.json", JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [{ type: "command", command: `"${root}/.fintopia/start.mjs" claude-code` }],
      }],
    },
  }));
  w(".kimi-code/config.toml",
    `extra_skill_dirs = ["${path.join(root, ".agents/skills")}"]\n`);
  w(".fintopia/start.mjs", `// installed under ${root}\nprocess.exit(0);\n`);
  fs.chmodSync(path.join(root, ".fintopia/start.mjs"), 0o755);

  // volatile: sessions, history, logs, caches
  w(".claude/projects/-some-project/a.jsonl", "{}\n");
  w(".claude/history.jsonl", "{}\n");
  w(".claude/cache/junk", "x");
  w(".cursor/chats/c1", "x");
  w(".kimi-code/logs/l1", "x");

  // a symlink pointing inside the env: must be dereferenced, not carried over
  fs.symlinkSync(
    path.join(root, ".fintopia/start.mjs"),
    path.join(root, ".claude/skills/demo/run.mjs"),
  );
}

describe("copyEnv", () => {
  test("volatile 清单是 env 相对路径，且不误伤 plugins/cache", () => {
    const v = volatilePaths();
    expect(v).toContain(".claude/cache");
    expect(v).toContain(".claude/projects");
    expect(v).toContain(".cursor/chats");
    expect(v).toContain(".kimi-code/logs");
    expect(v).toContain(".tread/sync.json");
    expect(v).not.toContain(".claude/plugins/cache");
  });

  test("四类内容逐 agent 计数相等", () => {
    const src = createEnv("src");
    seed(src);
    const r = copyEnv("src", "dst");
    expect(r.root).toBe(envDir("dst"));
    for (const a of ["claude", "cursor", "kimi"] as const) {
      const s = inventory(src, a);
      const d = inventory(r.root, a);
      expect([d.skills.length, d.plugins.length, d.mcp.length, d.hooks.length])
        .toEqual([s.skills.length, s.plugins.length, s.mcp.length, s.hooks.length]);
    }
    // not a vacuous equality: the seeded skill crossed over, next to the
    // `tread` skill every environment installs for itself
    const skills = inventory(r.root, "claude").skills.map((s) => s.name).sort();
    expect(skills).toEqual(["demo", "tread"]);
    expect(inventory(r.root, "claude").plugins.length).toBe(1);
    expect(inventory(r.root, "claude").mcp.length).toBe(1);
    expect(inventory(r.root, "claude").hooks.length).toBe(1);
  });

  test("精确匹配：.claude/cache 没了，plugins/cache 里的插件本体还在", () => {
    const dst = envDir("dst");
    expect(fs.existsSync(path.join(dst, ".claude/cache"))).toBe(false);
    expect(fs.existsSync(path.join(dst, ".claude/projects"))).toBe(false);
    expect(fs.existsSync(path.join(dst, ".claude/history.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dst, ".cursor/chats"))).toBe(false);
    expect(fs.existsSync(path.join(dst, ".kimi-code/logs"))).toBe(false);
    expect(fs.existsSync(path.join(
      dst, ".claude/plugins/cache/official/feature-dev/1.4.0/.claude-plugin/plugin.json",
    ))).toBe(true);
  });

  test("指向真 home 的路径在 dst 里仍是 symlink，且指向真 home 不指向 src", () => {
    const dst = envDir("dst");
    for (const rel of [".gitconfig", ".ssh", ".zshrc"]) {
      if (!fs.existsSync(path.join(os.homedir(), rel))) continue;
      const link = path.join(dst, rel);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join(os.homedir(), rel));
    }
  });

  test("指向 env 内部的 symlink 跟着走，但重指向 dst 自己的文件", () => {
    const dst = envDir("dst");
    const p = path.join(dst, ".claude/skills/demo/run.mjs");
    expect(fs.readlinkSync(p)).toBe(path.join(dst, ".fintopia/start.mjs"));
    expect(fs.readFileSync(p, "utf8")).toContain("process.exit(0)");
    // read through the link: the copied target kept its exec bit
    expect(fs.statSync(p).mode & 0o111).toBeGreaterThan(0);
  });

  test("改 src 不影响 dst", () => {
    const src = envDir("src");
    const dst = envDir("dst");
    fs.writeFileSync(path.join(src, ".claude/settings.json"), "{}");
    fs.writeFileSync(path.join(src, ".claude/skills/demo/SKILL.md"), "gutted");
    fs.rmSync(path.join(src, ".claude/.mcp.json"));
    fs.writeFileSync(path.join(src, ".claude/newcomer"), "x");
    expect(fs.readFileSync(path.join(dst, ".claude/skills/demo/SKILL.md"), "utf8"))
      .toContain("name: demo");
    expect(fs.existsSync(path.join(dst, ".claude/.mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(dst, ".claude/newcomer"))).toBe(false);
  });

  test(".tread：config.yaml 跟着走，sync.json 是重新生成的", () => {
    const src = createEnv("cfg");
    fs.writeFileSync(path.join(src, ".tread/config.yaml"), "allow:\n  extra: [.hushlogin]\n");
    fs.writeFileSync(path.join(src, ".tread/sync.json"), '{"version":1,"paths":["bogus"]}\n');
    const r = copyEnv("cfg", "cfg2");
    expect(fs.readFileSync(path.join(r.root, ".tread/config.yaml"), "utf8"))
      .toContain(".hushlogin");
    expect(fs.readFileSync(path.join(r.root, ".tread/sync.json"), "utf8"))
      .not.toContain("bogus");
  });

  test("非常规文件跳过而不是拷失败", () => {
    const src = createEnv("odd");
    const fifo = path.join(src, ".claude/pipe");
    Bun.spawnSync(["mkfifo", fifo]);
    if (!fs.existsSync(fifo)) return; // mkfifo unavailable: nothing to assert
    const r = copyEnv("odd", "odd2");
    expect(fs.existsSync(path.join(r.root, ".claude/pipe"))).toBe(false);
    expect(r.skipped).toContain(".claude/pipe");
  });

  test("错误路径：src 不存在 / dst 已存在 / dst 名字非法，且不留临时目录", () => {
    expect(() => copyEnv("nope", "x")).toThrow(/no environment named/);
    expect(() => copyEnv("src", "dst")).toThrow(/already exists/);
    expect(() => copyEnv("src", "../evil")).toThrow(/invalid name/);
    expect(fs.readdirSync(envsDir()).filter((n) => n.startsWith(".cp-"))).toEqual([]);
  });

  test("dst 里没有任何文件、任何链接指向 src", () => {
    const src = envDir("src");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          if (fs.readlinkSync(p).includes(src)) bad.push(p);
          continue;
        }
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!e.isFile()) continue;
        const buf = fs.readFileSync(p);
        if (buf.includes(0)) continue; // binary
        if (buf.toString("utf8").includes(src)) bad.push(p);
      }
    };
    walk(envDir("dst"));
    expect(bad).toEqual([]);
  });

  test("重写的是完整绝对路径，改成 dst 自己的", () => {
    const dst = envDir("dst");
    const settings = fs.readFileSync(path.join(dst, ".claude/settings.json"), "utf8");
    expect(settings).toContain(`${dst}/.fintopia/start.mjs`);
    const toml = fs.readFileSync(path.join(dst, ".kimi-code/config.toml"), "utf8");
    expect(toml).toContain(`${dst}/.agents/skills`);
    const plugins = fs.readFileSync(
      path.join(dst, ".claude/plugins/installed_plugins.json"), "utf8",
    );
    expect(plugins).toContain(`${dst}/.claude/plugins/cache`);
  });

  test("重写数计入结果，二进制文件不动", () => {
    const src = createEnv("bin");
    fs.writeFileSync(
      path.join(src, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "*", hooks: [{ type: "command", command: `${src}/.fintopia/start.mjs` }] },
          ],
        },
      }),
    );
    const blob = Buffer.concat([Buffer.from(src), Buffer.from([0, 1, 2])]);
    fs.writeFileSync(path.join(src, ".claude/blob.bin"), blob);
    const r = copyEnv("bin", "bin2");
    expect(r.rewritten).toBe(1);
    expect(fs.readFileSync(path.join(r.root, ".claude/blob.bin"))).toEqual(blob);
  });

  test("listEnvs 不把 cp 的临时目录当成环境", () => {
    const leftover = path.join(envsDir(), ".cp-leftover.999");
    fs.mkdirSync(leftover, { recursive: true });
    try {
      expect(listEnvs()).not.toContain(".cp-leftover.999");
    } finally {
      fs.rmSync(leftover, { recursive: true, force: true });
    }
  });
});

/**
 * The real topology: `<state>` lives under the real home, so a link to the
 * environment's own sibling file also points "into the real home". Reproduced
 * here because the tests above put the state dir in /tmp, where the two cases
 * happen to be distinguishable and the bug is invisible.
 */
describe("环境自己就在真 home 底下", () => {
  test("env 内部的链接不被当成 home 共享，跟着走且指向 dst", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tread-home-"));
    const prevHome = process.env.TREAD_HOME;
    const prevState = process.env.TREAD_STATE_DIR;
    process.env.TREAD_HOME = home;
    process.env.TREAD_STATE_DIR = path.join(home, ".local/state/tread");
    try {
      fs.writeFileSync(path.join(home, ".zshrc"), "# the real one\n");
      const src = createEnv("nested");
      const d = path.join(src, ".claude/plugins/cache/p/1.0.0");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "CLAUDE.md"), "guide\n");
      // exactly what superpowers ships: a sibling alias, relative
      fs.symlinkSync("CLAUDE.md", path.join(d, "AGENTS.md"));
      fs.writeFileSync(path.join(src, ".claude/settings.json"), "{}\n");
      fs.symlinkSync(path.join(src, ".claude/settings.json"), path.join(d, "abs.json"));

      const r = copyEnv("nested", "nested2");
      const dd = path.join(r.root, ".claude/plugins/cache/p/1.0.0");
      expect(fs.readlinkSync(path.join(dd, "AGENTS.md"))).toBe("CLAUDE.md");
      expect(fs.readFileSync(path.join(dd, "AGENTS.md"), "utf8")).toBe("guide\n");
      // an absolute link into src is repointed at dst's own copy
      expect(fs.readlinkSync(path.join(dd, "abs.json")))
        .toBe(path.join(r.root, ".claude/settings.json"));
      // while a genuine home share is still a link into the real home
      expect(fs.readlinkSync(path.join(r.root, ".zshrc"))).toBe(path.join(home, ".zshrc"));
    } finally {
      if (prevHome === undefined) delete process.env.TREAD_HOME;
      else process.env.TREAD_HOME = prevHome;
      if (prevState === undefined) delete process.env.TREAD_STATE_DIR;
      else process.env.TREAD_STATE_DIR = prevState;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
