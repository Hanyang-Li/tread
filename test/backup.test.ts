import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let home: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-backup-"));
  home = path.join(tmp, "home");
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  process.env.TREAD_HOME = home;
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.TREAD_HOME;
});

const {
  backupDir, backupsDir, backupStampFile, captureBinary, listBackups, restoreBinary,
} = await import("../src/backup.ts");

/** A single-file install behind a version symlink, the shape claude has. */
function installClaude(version: string, bytes: number): { launcher: string; origin: string } {
  const origin = path.join(home, ".local/share/claude/versions", version);
  const launcher = path.join(home, ".local/bin/claude");
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(origin, Buffer.alloc(bytes, version.charCodeAt(0)), { mode: 0o755 });
  fs.rmSync(launcher, { force: true });
  fs.symlinkSync(origin, launcher);
  return { launcher, origin };
}

/** A launcher script plus the payload beside it, the shape cursor-agent has. */
function installCursor(version: string): { launcher: string; dir: string } {
  const dir = path.join(home, ".local/share/cursor-agent/versions", version);
  const launcher = path.join(home, ".local/bin/cursor-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cursor-agent"), "#!/bin/sh\nexec node index.js\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "index.js"), "x".repeat(4096));
  fs.mkdirSync(path.join(dir, "chunks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "chunks/a.js"), "y".repeat(2048));
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.rmSync(launcher, { force: true });
  fs.symlinkSync(path.join(dir, "cursor-agent"), launcher);
  return { launcher, dir };
}

const inode = (p: string) => fs.statSync(p).ino;

beforeEach(() => {
  fs.rmSync(backupsDir(), { recursive: true, force: true });
  fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
});

describe("captureBinary", () => {
  test("单文件 agent：跟着 symlink 备份版本文件本身，而不是那个链接", () => {
    const { launcher, origin } = installClaude("2.1.245", 4096);
    const m = captureBinary("claude", launcher);
    expect(m.error).toBeUndefined();
    // realpath'd: the state dir may sit behind a symlink, and the manifest
    // has to name the file rather than a spelling of it
    expect(m.origin).toBe(fs.realpathSync(origin));
    expect(m.launcher).toBe(launcher);
    expect(m.linkTarget).toBe(origin);
    expect(m.kind).toBe("file");
    expect(m.bytes).toBe(4096);
    expect(fs.statSync(path.join(backupDir("claude"), "payload")).size).toBe(4096);
  });

  test("cursor：备份整个版本目录，只存那个 1.1k 启动脚本救不回来", () => {
    const { launcher, dir } = installCursor("2026.08.11");
    const m = captureBinary("cursor", launcher);
    expect(m.error).toBeUndefined();
    expect(m.kind).toBe("tree");
    // 备份的是目录，不是链接落点的那个脚本
    expect(m.origin).toBe(fs.realpathSync(dir));
    expect(m.linkTarget).toBe(path.join(dir, "cursor-agent"));
    const payload = path.join(backupDir("cursor"), "payload");
    expect(fs.existsSync(path.join(payload, "cursor-agent"))).toBe(true);
    expect(fs.existsSync(path.join(payload, "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(payload, "chunks/a.js"))).toBe(true);
  });

  test("clonefile 是独立 inode：这正是它取代硬链接的理由", () => {
    const { launcher, origin } = installClaude("2.1.245", 4096);
    captureBinary("claude", launcher);
    expect(inode(path.join(backupDir("claude"), "payload"))).not.toBe(inode(origin));
  });

  test("源被原地清零后备份完好 —— 硬链接在这里会一起变成 0 字节", () => {
    const { launcher, origin } = installClaude("2.1.245", 4096);
    captureBinary("claude", launcher);
    fs.truncateSync(origin, 0);
    expect(fs.statSync(origin).size).toBe(0);
    expect(fs.statSync(path.join(backupDir("claude"), "payload")).size).toBe(4096);
  });

  test("拒绝 0 字节的源：那正是更新失败留下的东西，不能盖掉好备份", () => {
    const good = installClaude("2.1.245", 4096);
    captureBinary("claude", good.launcher);
    // 更新失败：新版本文件是空壳，launcher 已经指过去了
    const bad = installClaude("2.1.246", 0);
    const m = captureBinary("claude", bad.launcher);
    expect(m.error).toBe("nothing to copy");
    // 好备份没被动过
    expect(fs.statSync(path.join(backupDir("claude"), "payload")).size).toBe(4096);
  });

  // 这里的 envsDir() 是未经 realpath 的 /var/... 形式，而 captureBinary 拿到的
  // origin 已经解析成 /private/var/...。只比一种拼写的话这个副本会被直接放行。
  test("拒绝环境内的副本：那是 doctor --fix 要删的东西，不该被留住", async () => {
    const { envsDir } = await import("../src/paths.ts");
    const inEnv = path.join(envsDir(), "work/.kimi-code/bin/kimi");
    fs.mkdirSync(path.dirname(inEnv), { recursive: true });
    fs.writeFileSync(inEnv, "x".repeat(64), { mode: 0o755 });
    const m = captureBinary("kimi", inEnv);
    expect(m.error).toBe("inside an environment");
    expect(fs.existsSync(path.join(backupDir("kimi"), "payload"))).toBe(false);
  });

  test("失败也写 manifest：它是 shim 的时间戳，否则每次启动都白试一遍", () => {
    const { launcher } = installClaude("2.1.246", 0);
    captureBinary("claude", launcher);
    expect(fs.existsSync(backupStampFile("claude"))).toBe(true);
  });

  test("重复备份就地替换，不会留下临时文件", () => {
    const { launcher } = installClaude("2.1.245", 4096);
    captureBinary("claude", launcher);
    const next = installClaude("2.1.246", 8192);
    const m = captureBinary("claude", next.launcher);
    expect(m.bytes).toBe(8192);
    expect(fs.readdirSync(backupDir("claude")).sort()).toEqual(["manifest.json", "payload"]);
  });
});

describe("listBackups", () => {
  test("current 认的是今天装着的版本，不是 manifest 自己说的", () => {
    const { launcher } = installClaude("2.1.245", 4096);
    captureBinary("claude", launcher);
    const realOf = (bin: string) => (bin === "claude" ? launcher : null);

    const before = listBackups(realOf).find((b) => b.agent === "claude")!;
    expect(before.present).toBe(true);
    expect(before.current).toBe(true);

    // agent 更新了，备份还停在上一版：仍然能用，但不是正在跑的那个
    const next = installClaude("2.1.246", 8192);
    const after = listBackups((bin) => (bin === "claude" ? next.launcher : null))
      .find((b) => b.agent === "claude")!;
    expect(after.present).toBe(true);
    expect(after.current).toBe(false);
  });

  test("没备份过的 agent 报 present=false 而不是抛错", () => {
    const list = listBackups(() => null);
    expect(list.map((b) => b.agent).sort()).toEqual(["claude", "cursor", "kimi"]);
    expect(list.every((b) => !b.present)).toBe(true);
  });
});

describe("restoreBinary", () => {
  test("单文件：内容放回原处，并把 launcher 重新指回去", () => {
    const { launcher, origin } = installClaude("2.1.245", 4096);
    captureBinary("claude", launcher);

    // 更新失败的完整形态：新版本是空壳，launcher 已经指向它，旧版本没了
    const bad = installClaude("2.1.246", 0);
    fs.rmSync(origin, { force: true });
    expect(fs.readlinkSync(launcher)).toBe(bad.origin);

    expect(restoreBinary("claude").ok).toBe(true);
    expect(fs.statSync(origin).size).toBe(4096);
    // 只放回文件是不够的：链接还指着那个空壳，命令依然跑不起来
    expect(fs.readlinkSync(launcher)).toBe(origin);
  });

  test("cursor：整个版本目录连同 launcher 一起回来", () => {
    const { launcher, dir } = installCursor("2026.08.11");
    captureBinary("cursor", launcher);
    fs.rmSync(dir, { recursive: true, force: true });

    expect(restoreBinary("cursor").ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "index.js"), "utf8").length).toBe(4096);
    expect(fs.existsSync(path.join(dir, "chunks/a.js"))).toBe(true);
    expect(fs.readlinkSync(launcher)).toBe(path.join(dir, "cursor-agent"));
  });

  test("覆盖掉留在原处的空壳，而不是躲开它", () => {
    const { launcher, origin } = installClaude("2.1.245", 4096);
    captureBinary("claude", launcher);
    fs.truncateSync(origin, 0);
    expect(restoreBinary("claude").ok).toBe(true);
    expect(fs.statSync(origin).size).toBe(4096);
  });

  test("没有备份时明确失败，不假装修好了", () => {
    const r = restoreBinary("kimi");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no backup");
  });
});

/**
 * 端到端跑一遍生成的 shim。
 *
 * 单测能证明 captureBinary 做对了事，证明不了 shim 会在正确的时机叫它 —— 而那
 * 段判断是纯 /bin/sh，跑起来才算数。这里同时钉住三件事：未激活环境也备份（说明
 * 那段在 early exec 之前）、备份完成后不再重复触发、以及 agent 本身照常启动。
 */
describe("shim 触发备份", () => {
  const wait = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await Bun.sleep(20);
    }
    return false;
  };

  test("首次启动触发一次，第二次不再触发，agent 照常运行", async () => {
    const { writeShims } = await import("../src/shims.ts");
    const { shimsDir } = await import("../src/paths.ts");

    const bin = path.join(tmp, "e2e/bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho ran\n", { mode: 0o755 });

    // 假 tread：记下被调用的参数，并做真 tread 会做的那件事 —— 落下 stamp
    const log = path.join(tmp, "e2e/calls.log");
    const stamp = backupStampFile("claude");
    fs.writeFileSync(
      path.join(bin, "tread"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`
        + `mkdir -p ${JSON.stringify(path.dirname(stamp))}\n: > ${JSON.stringify(stamp)}\n`,
      { mode: 0o755 },
    );

    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    process.env.TREAD_BIN = path.join(bin, "tread");
    try {
      writeShims();
    } finally {
      process.env.PATH = savedPath;
      delete process.env.TREAD_BIN;
    }

    const shim = path.join(shimsDir(), "claude");
    // 假 bin 排在最前，但后面留着真 PATH：shim 烘进去的 real= 已经指向假 claude，
    // 而后台那趟 tread 要用到 mkdir 之类的东西，跟真实环境里一样
    const run = () =>
      Bun.spawnSync([shim], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
      });

    // TREAD_ENV_DIR 没设 —— 备份仍然要发生，因为丢失跟环境无关
    const first = run();
    expect(new TextDecoder().decode(first.stdout).trim()).toBe("ran");
    // 等 stamp 而不是 log：备份是后台跑的，log 先落、stamp 后落，等错了那个
    // 就会在备份还没完成时发起第二次，测出来的是竞态而不是抑制逻辑
    expect(await wait(() => fs.existsSync(stamp))).toBe(true);
    expect(fs.readFileSync(log, "utf8").trim()).toBe(`_backup claude ${bin}/claude`);

    const second = run();
    expect(new TextDecoder().decode(second.stdout).trim()).toBe("ran");
    await Bun.sleep(200);
    // stamp 已经不比二进制旧了，这一趟应该一个进程都没 fork
    expect(fs.readFileSync(log, "utf8").trim().split("\n").length).toBe(1);
  });
});
