import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-env-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_ENV;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const {
  createEnv, ensureSkeleton, listEnvs, removeEnv, requireEnv, resolveEnv,
  touchLastUsed, lastUsed, syncHomeLinks,
} = await import("../src/env.ts");
const { envDir, skillsDir, agentDir } = await import("../src/paths.ts");
const { hardDeny, defaultAllow, envConfigFile } = await import("../src/config.ts");

/** Write a per-env config layer, then re-sync. */
function withEnvConfig(dir: string, yaml: string): void {
  const f = envConfigFile(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, yaml);
  syncHomeLinks(dir);
}

describe("env lifecycle", () => {
  test("create 建出三个 agent 骨架", () => {
    const dir = createEnv("work");
    expect(dir).toBe(envDir("work"));
    for (const a of ["claude", "cursor", "kimi"] as const) {
      expect(fs.existsSync(agentDir(dir, a))).toBe(true);
    }
    expect(fs.existsSync(skillsDir(dir, "kimi"))).toBe(true);
  });

  test("kimi 骨架不写 extra_skill_dirs：shim 移动 HOME 后原生就能发现", () => {
    const dir = envDir("work");
    const toml = path.join(dir, ".kimi-code/config.toml");
    if (fs.existsSync(toml)) {
      expect(fs.readFileSync(toml, "utf8")).not.toContain("extra_skill_dirs");
    }
  });

  test("kimi config 从真 home 播种 provider/model，但剥掉 hooks", () => {
    const real = path.join(os.homedir(), ".kimi-code/config.toml");
    if (!fs.existsSync(real)) return;
    const seeded = fs.readFileSync(path.join(envDir("work"), ".kimi-code/config.toml"), "utf8");
    expect(seeded).not.toContain("[[hooks]]");
    if (fs.readFileSync(real, "utf8").includes("default_model")) {
      expect(seeded).toContain("default_model");
    }
  });

  test("默认共享真 home：常见配置都在，且是 symlink 不是拷贝", () => {
    const dir = envDir("work");
    for (const rel of [".gitconfig", ".ssh", ".npmrc", ".zshrc"]) {
      if (!fs.existsSync(path.join(os.homedir(), rel))) continue;
      const link = path.join(dir, rel);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join(os.homedir(), rel));
    }
  });

  test("被隔离的目录绝不能链过来——链了就等于没隔离", () => {
    const dir = envDir("work");
    for (const rel of [".claude", ".cursor", ".kimi-code", ".agents"]) {
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) continue;
      expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
    }
  });

  test("嵌套拒绝：.config 整体共享，但 tread 自己的配置不进环境", () => {
    const dir = envDir("work");
    if (!fs.existsSync(path.join(os.homedir(), ".config"))) return;
    // .config is mirrored, not linked, so the denied child can be left out
    expect(fs.lstatSync(path.join(dir, ".config")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(dir, ".config/tread"))).toBe(false);
    // siblings of the denied path are still links, not copies
    for (const name of fs.readdirSync(path.join(os.homedir(), ".config"))) {
      if (name === "tread") continue;
      const p = path.join(dir, ".config", name);
      if (fs.existsSync(p)) expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
      break;
    }
  });

  test("hardDeny 覆盖三个 agent 目录、tread 自身，并按平台给出 cursor 的额外路径", () => {
    const mac = hardDeny("darwin");
    for (const d of [".claude", ".cursor", ".kimi-code", ".agents",
                     ".local/state", ".tread", ".config/tread"]) {
      expect(mac).toContain(d);
    }
    expect(mac).toContain("Library/Application Support/Cursor/User/globalStorage");
    expect(hardDeny("linux")).toContain(".config/cursor/User/globalStorage");
  });

  test("macOS 的 login keychain 必须共享，否则每个 agent 都登不上", () => {
    expect(defaultAllow("darwin")).toContain("Library/Keychains");
    expect(defaultAllow("linux")).not.toContain("Library/Keychains");
    if (process.platform !== "darwin") return;
    const dir = envDir("work");
    if (!fs.existsSync(path.join(os.homedir(), "Library/Keychains"))) return;
    // Library itself is mirrored so only Keychains crosses over — the rest is
    // app state, which is what the environment exists to keep apart
    expect(fs.lstatSync(path.join(dir, "Library")).isSymbolicLink()).toBe(false);
    expect(fs.readlinkSync(path.join(dir, "Library/Keychains")))
      .toBe(path.join(os.homedir(), "Library/Keychains"));
    expect(fs.existsSync(path.join(dir, "Library/Application Support"))).toBe(false);
  });

  test("只通往 deny 目标的路径整条跳过，不留空镜像目录", () => {
    const dir = envDir("work");
    // Library/Application Support is in the policy tree only because cursor's
    // globalStorage hangs off it. Nothing under it is allowed, so descending
    // would leave a chain of empty mirror directories and nothing else.
    expect(hardDeny("darwin")).toContain(
      "Library/Application Support/Cursor/User/globalStorage",
    );
    expect(fs.existsSync(path.join(dir, "Library/Application Support"))).toBe(false);
  });

  test("白名单：home 里没被允许的东西不进环境", () => {
    const dir = envDir("work");
    const probe = `.tread-unlisted-${process.pid}`;
    fs.writeFileSync(path.join(os.homedir(), probe), "x");
    try {
      syncHomeLinks(dir);
      // this is what makes a skill's own state directory isolated for free:
      // tread never had to know its name
      expect(fs.existsSync(path.join(dir, probe))).toBe(false);
      expect(defaultAllow("darwin")).not.toContain(probe);
    } finally {
      fs.rmSync(path.join(os.homedir(), probe), { force: true });
    }
  });

  test("配置分层：extra 加进来，remove 拿掉，且 remove 在层内优先", () => {
    const dir = envDir("work");
    const probe = `.tread-extra-${process.pid}`;
    fs.writeFileSync(path.join(os.homedir(), probe), "x");
    try {
      withEnvConfig(dir, `allow:\n  extra: [${probe}]\n`);
      expect(fs.lstatSync(path.join(dir, probe)).isSymbolicLink()).toBe(true);

      // dropping it from the config must actually remove the link — a config
      // that tightens without pruning is the worst way for this to fail
      withEnvConfig(dir, `allow:\n  extra: []\n`);
      expect(fs.existsSync(path.join(dir, probe))).toBe(false);

      // remove beats extra inside one layer
      withEnvConfig(dir, `allow:\n  extra: [${probe}]\n  remove: [${probe}]\n`);
      expect(fs.existsSync(path.join(dir, probe))).toBe(false);
    } finally {
      fs.rmSync(path.join(os.homedir(), probe), { force: true });
      fs.rmSync(envConfigFile(dir), { force: true });
      syncHomeLinks(dir);
    }
  });

  test("配置碰不到硬 deny，且会报出来", () => {
    const dir = envDir("work");
    try {
      const f = envConfigFile(dir);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `allow:\n  extra: [.claude]\n`);
      const r = syncHomeLinks(dir);
      expect(fs.lstatSync(path.join(dir, ".claude")).isSymbolicLink()).toBe(false);
      expect(r.problems.some((p) => p.message.includes("always isolated"))).toBe(true);
    } finally {
      fs.rmSync(envConfigFile(dir), { force: true });
      syncHomeLinks(dir);
    }
  });

  test("坏配置只报不炸，环境照常同步", () => {
    const dir = envDir("work");
    try {
      const f = envConfigFile(dir);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `allow:\n  extra: ["/etc/passwd", "../escape"]\n  bogus: 1\n`);
      const r = syncHomeLinks(dir);
      expect(r.problems.length).toBeGreaterThanOrEqual(3);
      expect(fs.existsSync(path.join(dir, ".gitconfig"))
        || !fs.existsSync(path.join(os.homedir(), ".gitconfig"))).toBe(true);
    } finally {
      fs.rmSync(envConfigFile(dir), { force: true });
      syncHomeLinks(dir);
    }
  });

  test("迁移旧环境：接管前一套方案留下的链接和空镜像目录", () => {
    const dir = createEnv("legacy");
    // an env built before the manifest existed: links into the real home, and
    // a mirror directory whose only child is another empty mirror
    fs.rmSync(path.join(dir, ".tread/sync.json"), { force: true });
    fs.mkdirSync(path.join(dir, "Legacy/Nested"), { recursive: true });
    const stray = path.join(dir, "Legacy", "gitconfig");
    fs.symlinkSync(path.join(os.homedir(), ".gitconfig"), stray);

    syncHomeLinks(dir);
    expect(fs.existsSync(path.join(dir, "Legacy"))).toBe(false);
    // and the ones it still wants survive
    if (fs.existsSync(path.join(os.homedir(), ".zshrc"))) {
      expect(fs.lstatSync(path.join(dir, ".zshrc")).isSymbolicLink()).toBe(true);
    }
    removeEnv("legacy");
  });

  test("prune 只删指向真 home 的链接和空目录，不碰环境自己的东西", () => {
    const dir = createEnv("owned");
    const own = path.join(dir, "Keep");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "data.txt"), "mine");
    fs.rmSync(path.join(dir, ".tread/sync.json"), { force: true });

    syncHomeLinks(dir);
    // rmdir, never rm -r: a non-empty directory the agent owns stays put
    expect(fs.readFileSync(path.join(own, "data.txt"), "utf8")).toBe("mine");
    removeEnv("owned");
  });

  test("dryRun 只报告不落盘", () => {
    const dir = envDir("work");
    const probe = `.tread-dry-${process.pid}`;
    fs.writeFileSync(path.join(os.homedir(), probe), "x");
    try {
      const f = envConfigFile(dir);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `allow:\n  extra: [${probe}]\n`);
      const r = syncHomeLinks(dir, { dryRun: true });
      expect(r.added).toContain(probe);
      expect(fs.existsSync(path.join(dir, probe))).toBe(false);
    } finally {
      fs.rmSync(path.join(os.homedir(), probe), { force: true });
      fs.rmSync(envConfigFile(dir), { force: true });
      syncHomeLinks(dir);
    }
  });

  test(".local 不整体链接，避免把环境套进自己里；但 bin/share 仍可达", () => {
    const dir = envDir("work");
    expect(fs.lstatSync(path.join(dir, ".local")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(dir, ".local/state/tread"))).toBe(false);
    if (fs.existsSync(path.join(os.homedir(), ".local/bin"))) {
      expect(fs.lstatSync(path.join(dir, ".local/bin")).isSymbolicLink()).toBe(true);
    }
  });

  test("重新同步能接上后来才出现的配置，消失后又清掉", () => {
    const dir = envDir("work");
    const probe = `.tread-probe-${process.pid}`;
    const real = path.join(os.homedir(), probe);
    try {
      const f = envConfigFile(dir);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `allow:\n  extra: [${probe}]\n`);

      // allowed but not there yet: reported, not linked
      expect(syncHomeLinks(dir).missing).toContain(probe);
      expect(fs.existsSync(path.join(dir, probe))).toBe(false);

      fs.writeFileSync(real, "x");
      syncHomeLinks(dir);
      expect(fs.readlinkSync(path.join(dir, probe))).toBe(real);

      // and prunes it again once it disappears from the real home
      fs.rmSync(real);
      syncHomeLinks(dir);
      expect(fs.existsSync(path.join(dir, probe))).toBe(false);
    } finally {
      fs.rmSync(real, { force: true });
      fs.rmSync(envConfigFile(dir), { force: true });
      syncHomeLinks(dir);
    }
  });

  test("环境里的真实文件不会被链接覆盖", () => {
    const dir = envDir("work");
    const probe = `.tread-own-${process.pid}`;
    fs.writeFileSync(path.join(os.homedir(), probe), "home");
    fs.writeFileSync(path.join(dir, probe), "mine");
    try {
      const f = envConfigFile(dir);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `allow:\n  extra: [${probe}]\n`);
      syncHomeLinks(dir);
      expect(fs.lstatSync(path.join(dir, probe)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(dir, probe), "utf8")).toBe("mine");
    } finally {
      fs.rmSync(path.join(os.homedir(), probe), { force: true });
      fs.rmSync(path.join(dir, probe), { force: true });
      fs.rmSync(envConfigFile(dir), { force: true });
      syncHomeLinks(dir);
    }
  });

  test("kimi 凭证 symlink 指回真 home", () => {
    const dir = envDir("work");
    for (const n of ["credentials", "oauth"]) {
      const p = path.join(dir, ".kimi-code", n);
      expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(p)).toBe(path.join(os.homedir(), ".kimi-code", n));
    }
  });

  test("重复 create 报错", () => {
    expect(() => createEnv("work")).toThrow(/already exists/);
  });

  test("ensureSkeleton 幂等且自愈", () => {
    const dir = envDir("work");
    fs.rmSync(agentDir(dir, "cursor"), { recursive: true, force: true });
    ensureSkeleton(dir);
    expect(fs.existsSync(agentDir(dir, "cursor"))).toBe(true);
    expect(() => ensureSkeleton(dir)).not.toThrow();
  });

  test("ensureSkeleton 不覆盖已存在的 config.toml", () => {
    const dir = envDir("work");
    const f = path.join(dir, ".kimi-code/config.toml");
    fs.writeFileSync(f, 'default_model = "x"\n');
    ensureSkeleton(dir);
    expect(fs.readFileSync(f, "utf8")).toBe('default_model = "x"\n');
  });

  test("list / require / remove", () => {
    createEnv("alpha");
    expect(listEnvs()).toEqual(["alpha", "work"]);
    expect(requireEnv("work")).toBe(envDir("work"));
    expect(() => requireEnv("nope")).toThrow(/no environment named/);
    removeEnv("alpha");
    expect(listEnvs()).toEqual(["work"]);
  });

  test("requireEnv 给出 did-you-mean", () => {
    expect(() => requireEnv("wrok")).toThrow(/did you mean "work"/);
  });

  test("resolveEnv 回落到 TREAD_ENV", () => {
    process.env.TREAD_ENV = "work";
    expect(resolveEnv()).toBe(envDir("work"));
    delete process.env.TREAD_ENV;
    expect(() => resolveEnv()).toThrow(/no environment active/);
  });

  test("lastUsed 持久化", () => {
    touchLastUsed("work");
    expect(typeof lastUsed().work).toBe("string");
  });
});
