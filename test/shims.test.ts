import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-shim-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const {
  writeShims, shimsHealthy, realBinary, findInEnvBinaries, removeInEnvBinary, envPathEntries,
} = await import("../src/shims.ts");
const { shimsDir, envsDir } = await import("../src/paths.ts");

/**
 * 一个顶替 cursor-agent 的假二进制。
 *
 * 旁边的 node 和 index.js 不是摆设：realBinary 检查的是启动脚本真正 exec 的那些
 * 文件，光有一个脚本会被判为跑不起来，shim 就会转而把真的 cursor-agent 烘进去。
 */
function fakeCursor(dir: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node"), "placeholder", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "index.js"), "placeholder");
  const p = path.join(dir, "cursor-agent");
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

describe("shims", () => {
  test("为每个 agent 及其别名各生成一个可执行 shim", () => {
    writeShims();
    for (const n of ["claude", "cursor-agent", "agent", "kimi"]) {
      const p = path.join(shimsDir(), n);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).mode & 0o111).toBeGreaterThan(0);
    }
  });

  test("每个 shim 都改 HOME：配置变量管不住走 homedir() 的第三方代码", () => {
    const read = (n: string) => fs.readFileSync(path.join(shimsDir(), n), "utf8");
    // cursor resolves mcp.json / hooks.json through homedir(); kimi finds
    // skills under ~/.agents/skills; a claude skill installing a hook writes
    // join(homedir(), ".claude", "settings.json") whatever CLAUDE_CONFIG_DIR says
    for (const n of ["cursor-agent", "agent", "kimi", "claude"]) {
      expect(read(n)).toContain('HOME="$TREAD_ENV_DIR"');
    }
  });

  test("shim 注入各自的隔离变量", () => {
    const read = (n: string) => fs.readFileSync(path.join(shimsDir(), n), "utf8");
    expect(read("claude")).toContain("CLAUDE_CONFIG_DIR=");
    expect(read("cursor-agent")).toContain("CURSOR_CONFIG_DIR=");
    expect(read("cursor-agent")).toContain("CURSOR_DATA_DIR=");
    expect(read("kimi")).toContain("KIMI_CODE_HOME=");
  });

  test("未激活时 shim 直接透传给真二进制", () => {
    const body = fs.readFileSync(path.join(shimsDir(), "claude"), "utf8");
    expect(body).toContain('if [ -z "${TREAD_ENV_DIR:-}" ]; then');
    expect(body).toContain('exec "$real" "$@"');
  });

  test("写入幂等：第二次不改文件", () => {
    writeShims();
    expect(writeShims()).toEqual([]);
  });

  test("shimsHealthy 在生成后为真", () => {
    expect(shimsHealthy()).toBe(true);
  });

  test("realBinary 跳过 shim 目录，不会解析到自己", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${shimsDir()}:${prev}`;
    const found = realBinary("claude");
    expect(found).not.toBe(path.join(shimsDir(), "claude"));
    process.env.PATH = prev;
  });

  // 更新失败留下的就是这个：文件在、可执行位在、只是 0 字节。前面每一道检查它
  // 都过得去，doctor 会给一个跑不起来的命令报 ok。
  test("realBinary 跳过 0 字节的二进制：那是更新失败的残骸，不是能跑的东西", () => {
    const dir = path.join(tmp, "emptybin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "kimi"), "", { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(realBinary("kimi")).toBe(null);
    } finally {
      process.env.PATH = prev;
    }
  });

  // cursor-agent 在 PATH 上的那个文件是启动脚本，真正跑的是它同目录 exec 的
  // node 和 index.js。只看脚本的话，负载没了它照样报健康 —— 于是 doctor --fix
  // 也会拒绝恢复，因为在它看来根本没出问题。
  test("realBinary 看的是 cursor 真正要跑的东西，不是 PATH 上那个启动脚本", () => {
    const dir = path.join(tmp, "cursor-payload");
    fakeCursor(dir, "#!/bin/sh\nexit 0\n");
    const prev = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(realBinary("cursor-agent")).toBe(path.join(dir, "cursor-agent"));

      // 负载被清零：脚本本身完好，可执行位也在
      fs.writeFileSync(path.join(dir, "node"), "");
      expect(realBinary("cursor-agent")).toBe(null);

      // 负载整个消失
      fs.writeFileSync(path.join(dir, "node"), "placeholder", { mode: 0o755 });
      fs.rmSync(path.join(dir, "index.js"));
      expect(realBinary("cursor-agent")).toBe(null);
    } finally {
      process.env.PATH = prev;
    }
  });

  test("生成的 shim 是合法 sh 脚本", async () => {
    for (const n of ["claude", "cursor-agent", "kimi"]) {
      const p = Bun.spawn(["sh", "-n", path.join(shimsDir(), n)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await p.exited).toBe(0);
    }
  });

  test("claude shim 只在环境内禁用自身更新", async () => {
    const fakeDir = path.join(tmp, "fakebin-claude-update");
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeDir, "claude"),
      '#!/bin/sh\nprintf "updates=%s auto=%s\\n" "${DISABLE_UPDATES-UNSET}" "${DISABLE_AUTOUPDATER-UNSET}"\n',
      { mode: 0o755 },
    );

    const prev = process.env.PATH;
    process.env.PATH = `${fakeDir}:${prev}`;
    fs.rmSync(shimsDir(), { recursive: true, force: true });
    writeShims();
    process.env.PATH = prev;

    const run = async (envRoot: string): Promise<string> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${fakeDir}:${prev}`,
        TREAD_ENV_DIR: envRoot,
      };
      delete env.DISABLE_UPDATES;
      delete env.DISABLE_AUTOUPDATER;
      const proc = Bun.spawn([path.join(shimsDir(), "claude")], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return out.trim();
    };

    expect(await run(path.join(tmp, "envs", "updates-off"))).toBe("updates=1 auto=1");
    expect(await run("")).toBe("updates=UNSET auto=UNSET");
  });

  test("shim 真的会把 HOME 和变量传给被调用的程序", async () => {
    // stand in for cursor-agent: a script that prints what it received
    const fakeDir = path.join(tmp, "fakebin");
    fakeCursor(fakeDir, '#!/bin/sh\necho "HOME=$HOME"\necho "CFG=$CURSOR_CONFIG_DIR"\n');

    const prev = process.env.PATH;
    process.env.PATH = `${fakeDir}:${prev}`;
    fs.rmSync(shimsDir(), { recursive: true, force: true });
    writeShims();
    process.env.PATH = prev;

    const envRoot = path.join(tmp, "envs", "probe");
    fs.mkdirSync(envRoot, { recursive: true });
    const p = Bun.spawn([path.join(shimsDir(), "cursor-agent")], {
      env: { ...process.env, TREAD_ENV_DIR: envRoot, PATH: `${fakeDir}:${prev}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain(`HOME=${envRoot}`);
    expect(out).toContain(`CFG=${envRoot}/.cursor`);
  });

  test("shim 在改 HOME 前先把真 home 存进 TREAD_HOME", async () => {
    // otherwise a `tread` the agent shells out to resolves its own state dir
    // into the environment and reports no environments at all
    const fakeDir = path.join(tmp, "fakebin");
    fakeCursor(fakeDir, '#!/bin/sh\necho "HOME=$HOME"\necho "REAL=$TREAD_HOME"\n');
    const envRoot = path.join(tmp, "envs", "probe");
    const p2 = Bun.spawn([path.join(shimsDir(), "cursor-agent")], {
      env: {
        ...process.env,
        TREAD_ENV_DIR: envRoot,
        HOME: "/real/home",
        TREAD_HOME: "",
        PATH: `${fakeDir}:${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p2.stdout).text();
    await p2.exited;
    expect(out).toContain(`HOME=${envRoot}`);
    expect(out).toContain("REAL=/real/home");
  });

  test("未激活时 shim 不改 HOME", async () => {
    const fakeDir = path.join(tmp, "fakebin");
    const prev = process.env.PATH;
    const p = Bun.spawn([path.join(shimsDir(), "cursor-agent")], {
      env: { ...process.env, PATH: `${fakeDir}:${prev}`, TREAD_ENV_DIR: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain(`HOME=${process.env.HOME}`);
  });

  // last: regenerates the shim dir against its own fake PATH, which would
  // strip the fake binaries the tests above bake into `real=`
  test("claude 里的 skill 用 os.homedir() 算出的 ~/.claude 落在环境内", async () => {
    // the regression: skills-auto-update writes its hook to
    // join(os.homedir(), ".claude", "settings.json"). CLAUDE_CONFIG_DIR never
    // reaches that code path — only HOME does.
    const fakeDir = path.join(tmp, "fakebin-homedir");
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeDir, "claude"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e ` +
        `'console.log(require("path").join(require("os").homedir(),".claude","settings.json"))'\n`,
      { mode: 0o755 },
    );

    const prev = process.env.PATH;
    process.env.PATH = `${fakeDir}:${prev}`;
    fs.rmSync(shimsDir(), { recursive: true, force: true });
    writeShims();
    process.env.PATH = prev;

    const envRoot = path.join(tmp, "envs", "homedir");
    fs.mkdirSync(envRoot, { recursive: true });
    const p = Bun.spawn([path.join(shimsDir(), "claude")], {
      env: { ...process.env, TREAD_ENV_DIR: envRoot, PATH: `${fakeDir}:${prev}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out.trim()).toBe(path.join(envRoot, ".claude", "settings.json"));
  });
});

describe("shim 里的登录共享", () => {
  // The distinction under test is not "which value" but "set vs unset": claude
  // appends a hash of CLAUDE_CONFIG_DIR to its keychain service name unless
  // CLAUDE_SECURESTORAGE_CONFIG_DIR is *defined and empty*. So the fake agent
  // prints ${VAR-UNSET}, which is the only way to tell the two apart, and an
  // empty export surviving a /bin/sh shim is the thing being proven.
  const probe = '#!/bin/sh\necho "SECURE=[${CLAUDE_SECURESTORAGE_CONFIG_DIR-UNSET}]"\n';

  async function run(envRoot: string): Promise<string> {
    const fakeDir = path.join(tmp, "fakebin-login");
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, "claude"), probe, { mode: 0o755 });

    const prev = process.env.PATH;
    process.env.PATH = `${fakeDir}:${prev}`;
    fs.rmSync(shimsDir(), { recursive: true, force: true });
    writeShims();
    process.env.PATH = prev;

    const p = Bun.spawn([path.join(shimsDir(), "claude")], {
      env: { ...process.env, TREAD_ENV_DIR: envRoot, PATH: `${fakeDir}:${prev}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }

  test("默认共享：变量已定义且为空，keychain item 回到真实 home 那个", async () => {
    const envRoot = path.join(tmp, "envs", "login-shared");
    fs.mkdirSync(path.join(envRoot, ".tread"), { recursive: true });
    expect(await run(envRoot)).toContain("SECURE=[]");
  });

  test("有 isolate 标记时变量指向本环境的 config dir", async () => {
    const envRoot = path.join(tmp, "envs", "login-isolated");
    fs.mkdirSync(path.join(envRoot, ".tread"), { recursive: true });
    fs.writeFileSync(path.join(envRoot, ".tread", "isolate-login-claude"), "x");
    expect(await run(envRoot)).toContain(`SECURE=[${envRoot}/.claude]`);
  });

  test("cursor 和 kimi 的 shim 不带这段：它们本来就共享", () => {
    writeShims();
    for (const n of ["cursor-agent", "kimi"]) {
      const body = fs.readFileSync(path.join(shimsDir(), n), "utf8");
      expect(body).not.toContain("isolate-login");
    }
  });
});

describe("shim 覆写", () => {
  test("覆写走替换而非截断：内容还原且始终可执行", () => {
    writeShims();
    const target = path.join(shimsDir(), "claude");
    const want = fs.readFileSync(target, "utf8");
    expect(want.length).toBeGreaterThan(0);

    // dirty it, then let tread put it back
    fs.writeFileSync(target, "stale\n", { mode: 0o755 });
    expect(writeShims()).toContain("claude");
    expect(fs.readFileSync(target, "utf8")).toBe(want);
    expect(fs.statSync(target).mode & 0o111).toBeGreaterThan(0);
  });

  test("覆写期间被 exec 的旧 shim 仍然完整（rename 不动运行中的 inode）", async () => {
    writeShims();
    const target = path.join(shimsDir(), "claude");
    const before = fs.statSync(target).ino;
    fs.writeFileSync(target, "stale\n", { mode: 0o755 });
    writeShims();
    // a replacement, not a truncate-and-write: the file is a new inode
    expect(fs.statSync(target).ino).not.toBe(before);
  });

  test("不在 shim 目录里留临时文件", () => {
    writeShims();
    expect(fs.readdirSync(shimsDir()).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});

describe("自动更新：环境内关掉，环境外不动", () => {
  /**
   * Run one shim against a fake binary that reports what it was handed.
   *
   * `real=` is resolved while the shims are written, so the fake has to be on
   * PATH for both halves — generation and launch — or the shim bakes in the
   * machine's actual agent and the test measures that instead.
   */
  async function run(name: string, probe: string, envRoot: string): Promise<string> {
    const fakeDir = path.join(tmp, `fakebin-noupdate-${name}`);
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, name), probe, { mode: 0o755 });
    // cursor-agent 的健康检查看的是它 exec 的 node 和 index.js，不是 PATH 上那个
    // 脚本；对 kimi 来说这两个文件只是躺在旁边，不碍事
    fs.writeFileSync(path.join(fakeDir, "node"), "placeholder", { mode: 0o755 });
    fs.writeFileSync(path.join(fakeDir, "index.js"), "placeholder");

    const prev = process.env.PATH;
    process.env.PATH = `${fakeDir}:${prev}`;
    fs.rmSync(shimsDir(), { recursive: true, force: true });
    writeShims();
    process.env.PATH = prev;

    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${fakeDir}:${prev}`,
      TREAD_ENV_DIR: envRoot,
    };
    delete env.KIMI_CODE_NO_AUTO_UPDATE;
    delete env.KIMI_CLI_NO_AUTO_UPDATE;
    const proc = Bun.spawn([path.join(shimsDir(), name), "--print", "hi"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out.trim();
  }

  const kimiProbe =
    '#!/bin/sh\nprintf "code=%s legacy=%s\\n" '
    + '"${KIMI_CODE_NO_AUTO_UPDATE-UNSET}" "${KIMI_CLI_NO_AUTO_UPDATE-UNSET}"\n';

  test("kimi shim 只在环境内禁用自身更新", async () => {
    // kimi installs into KIMI_CODE_HOME, which is the *isolated* .kimi-code —
    // so an update in here is a second 180MB binary inside the environment
    expect(await run("kimi", kimiProbe, path.join(tmp, "envs", "kimi-off"))).toBe(
      "code=1 legacy=1",
    );
    expect(await run("kimi", kimiProbe, "")).toBe("code=UNSET legacy=UNSET");
  });

  const cursorProbe = '#!/bin/sh\nprintf "args=%s\\n" "$*"\n';

  test("cursor 没有环境变量可用，shim 把 flag 插在用户参数前面", async () => {
    expect(await run("cursor-agent", cursorProbe, path.join(tmp, "envs", "cursor-off"))).toBe(
      "args=--disable-auto-update --print hi",
    );
  });

  test("环境外的 cursor 参数原样透传，一个字都不加", async () => {
    expect(await run("cursor-agent", cursorProbe, "")).toBe("args=--print hi");
  });
});

describe("环境内的自更新副本", () => {
  const envName = "selfupdated";
  const envBinDir = () => path.join(envsDir(), envName, ".kimi-code", "bin");

  function seed(): { inside: string; outside: string } {
    const inside = path.join(envBinDir(), "kimi");
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const outsideDir = path.join(tmp, "outside-bin");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, "kimi");
    fs.writeFileSync(outside, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { inside, outside };
  }

  test("realBinary 跳过环境内的目录，即使 PATH 把它排在前面", () => {
    // exactly the order kimi's installer leaves behind: it prepends
    // `<env>/.kimi-code/bin` to the shared .zshrc, ahead of the real install
    const { inside, outside } = seed();
    const prev = process.env.PATH;
    process.env.PATH = `${path.dirname(inside)}:${path.dirname(outside)}`;
    expect(realBinary("kimi")).toBe(outside);
    process.env.PATH = prev;
  });

  test("realBinary 也拒绝只是指向环境内的软链", () => {
    const { inside } = seed();
    const linkDir = path.join(tmp, "link-bin");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "kimi");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(inside, link);
    const prev = process.env.PATH;
    process.env.PATH = linkDir;
    expect(realBinary("kimi")).toBe(null);
    process.env.PATH = prev;
  });

  test("findInEnvBinaries 报出副本、体积，以及它遮住了谁", () => {
    const { inside, outside } = seed();
    const prev = process.env.PATH;
    process.env.PATH = `${path.dirname(inside)}:${path.dirname(outside)}`;
    const found = findInEnvBinaries();
    process.env.PATH = prev;

    expect(found).toHaveLength(1);
    expect(found[0]!.agent).toBe("kimi");
    expect(found[0]!.env).toBe(envName);
    expect(found[0]!.path).toBe(inside);
    expect(found[0]!.size).toBeGreaterThan(0);
    expect(found[0]!.outside).toBe(outside);
  });

  test("--fix 删掉副本，连空掉的 bin 目录一起", () => {
    const { inside, outside } = seed();
    const prev = process.env.PATH;
    process.env.PATH = path.dirname(outside);
    const [b] = findInEnvBinaries();
    expect(removeInEnvBinary(b!)).toBe(true);
    process.env.PATH = prev;

    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(path.dirname(inside))).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  test("外面没有副本时拒绝删除：tread 不拿掉唯一的一份", () => {
    const { inside } = seed();
    const prev = process.env.PATH;
    process.env.PATH = path.join(tmp, "nothing-here");
    const [b] = findInEnvBinaries();
    expect(b!.outside).toBe(null);
    expect(removeInEnvBinary(b!)).toBe(false);
    process.env.PATH = prev;
    expect(fs.existsSync(inside)).toBe(true);
  });

  test("软链回真实 home 的不算副本：那是 ensureSkeleton 在正常工作", () => {
    fs.rmSync(envBinDir(), { recursive: true, force: true });
    fs.mkdirSync(envBinDir(), { recursive: true });
    const outsideDir = path.join(tmp, "outside-bin");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, "kimi");
    fs.writeFileSync(outside, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.symlinkSync(outside, path.join(envBinDir(), "kimi"));
    expect(findInEnvBinaries()).toEqual([]);
    fs.rmSync(envBinDir(), { recursive: true, force: true });
  });
});

describe("PATH 里指向环境的条目", () => {
  test("报出条目和写下它的那一行 rc", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const dir = path.join(envsDir(), "consult", ".kimi-code", "bin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(home, ".zshrc"),
      `# something\nexport PATH="${dir}:$PATH"\n`,
    );

    const prevHome = process.env.TREAD_HOME;
    const prevPath = process.env.PATH;
    process.env.TREAD_HOME = home;
    process.env.PATH = `${dir}:/usr/bin`;
    const found = envPathEntries();
    process.env.TREAD_HOME = prevHome;
    process.env.PATH = prevPath;

    expect(found).toEqual([{ dir, env: "consult", source: ".zshrc:2" }]);
  });

  test("当前环境把自己的目录放上 PATH 不算问题：claude 的插件 bin 就是这样", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const envRoot = path.join(envsDir(), "cli-dev");
    const pluginBin = path.join(envRoot, ".claude/plugins/cache/x/1.0.0/bin");
    fs.mkdirSync(pluginBin, { recursive: true });

    const prevHome = process.env.TREAD_HOME;
    const prevPath = process.env.PATH;
    const prevEnv = process.env.TREAD_ENV_DIR;
    process.env.TREAD_HOME = home;
    process.env.TREAD_ENV_DIR = envRoot;
    process.env.PATH = `${pluginBin}:/usr/bin`;
    const found = envPathEntries();
    process.env.TREAD_HOME = prevHome;
    process.env.PATH = prevPath;
    if (prevEnv === undefined) delete process.env.TREAD_ENV_DIR;
    else process.env.TREAD_ENV_DIR = prevEnv;

    expect(found).toEqual([]);
  });

  test("rc 里已经没有了就只是这个 shell 的残留，不算待办", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const dir = path.join(envsDir(), "consult", ".kimi-code", "bin");
    const prevHome = process.env.TREAD_HOME;
    const prevPath = process.env.PATH;
    process.env.TREAD_HOME = home;
    process.env.PATH = `${dir}:/usr/bin`;
    const found = envPathEntries();
    process.env.TREAD_HOME = prevHome;
    process.env.PATH = prevPath;

    expect(found).toEqual([{ dir, env: "consult", source: null }]);
  });
});
