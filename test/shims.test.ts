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

const { writeShims, shimsHealthy, realBinary } = await import("../src/shims.ts");
const { shimsDir } = await import("../src/paths.ts");

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
    fs.mkdirSync(fakeDir, { recursive: true });
    const fake = path.join(fakeDir, "cursor-agent");
    fs.writeFileSync(fake, '#!/bin/sh\necho "HOME=$HOME"\necho "CFG=$CURSOR_CONFIG_DIR"\n', {
      mode: 0o755,
    });

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
    const fake = path.join(fakeDir, "cursor-agent");
    fs.writeFileSync(fake, '#!/bin/sh\necho "HOME=$HOME"\necho "REAL=$TREAD_HOME"\n', {
      mode: 0o755,
    });
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
