import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let lock: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-lock-"));
  lock = path.join(tmp, "d", "sync.lock");
  process.env.TREAD_LOCK_TIMEOUT_MS = "300";
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(lock, { force: true }));

const { withLock, staleLock, clearStale } = await import("../src/lock.ts");

/** Plant a lock owned by someone else. */
function plant(owner: { pid: number; host?: string; at?: number }): void {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(
    lock,
    JSON.stringify({
      pid: owner.pid,
      host: owner.host ?? os.hostname(),
      at: owner.at ?? Date.now(),
    }),
  );
}

describe("withLock", () => {
  test("跑完把锁释放掉，返回值透传", () => {
    expect(withLock(lock, "work", () => 42)).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("抛异常也释放锁", () => {
    expect(() =>
      withLock(lock, "work", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("重入不自死锁", () => {
    const got = withLock(lock, "work", () => withLock(lock, "work", () => "inner"));
    expect(got).toBe("inner");
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("锁被活着的进程持有 → 超时报错，且带持有者信息", () => {
    plant({ pid: process.ppid });
    let err: Error | null = null;
    try {
      withLock(lock, "work", () => "never");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('"work"');
    expect(err!.message).toContain(String(process.ppid));
    expect(err!.message).toContain("nothing was changed");
    // someone else's lock must survive
    expect(fs.existsSync(lock)).toBe(true);
  });

  test("超时是有界的，不会挂死", () => {
    plant({ pid: process.ppid });
    const t = Date.now();
    expect(() => withLock(lock, "work", () => 0)).toThrow();
    const waited = Date.now() - t;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(3000);
  });

  test("持有者 pid 已死 → 立刻破锁，不等满超时", () => {
    plant({ pid: 999_999 });
    const t = Date.now();
    expect(withLock(lock, "work", () => "ok")).toBe("ok");
    expect(Date.now() - t).toBeLessThan(250);
  });

  test("pid 还活着但超龄 → 破锁（防 pid 回收）", () => {
    plant({ pid: process.ppid, at: Date.now() - 120_000 });
    expect(withLock(lock, "work", () => "ok")).toBe("ok");
  });

  test("跨主机的 pid 不作数，只看年龄", () => {
    plant({ pid: process.ppid, host: "some-other-host", at: Date.now() - 120_000 });
    expect(withLock(lock, "work", () => "ok")).toBe("ok");

    plant({ pid: 999_999, host: "some-other-host", at: Date.now() });
    expect(() => withLock(lock, "work", () => 0)).toThrow();
  });

  test("时钟回拨不会把新锁判成古董", () => {
    plant({ pid: process.ppid, at: Date.now() + 3_600_000 });
    expect(() => withLock(lock, "work", () => 0)).toThrow();
  });

  test("身份文件损坏 → 用 mtime 兜底，超过宽限期才破", () => {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "not json at all");
    expect(() => withLock(lock, "work", () => 0)).toThrow(); // still inside the grace period

    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    expect(withLock(lock, "work", () => "ok")).toBe("ok");
  });

  test("锁被合法抢走后，自己 release 不误删新持有者的锁", () => {
    withLock(lock, "work", () => {
      // as if we had stalled long enough to be judged abandoned, and lost it
      fs.writeFileSync(
        lock,
        JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() }),
      );
    });
    expect(fs.existsSync(lock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, "utf8")).pid).toBe(process.ppid);
  });

  test("非争用类错误直接抛，不假装拿到了锁", () => {
    const ro = path.join(tmp, "readonly");
    fs.mkdirSync(ro, { recursive: true });
    fs.chmodSync(ro, 0o500);
    try {
      expect(() => withLock(path.join(ro, "x.lock"), "work", () => 0)).toThrow();
    } finally {
      fs.chmodSync(ro, 0o700);
    }
  });
});

describe("staleLock / clearStale", () => {
  test("没有锁时都是 false", () => {
    expect(staleLock(lock)).toBe(false);
    expect(clearStale(lock)).toBe(false);
  });

  test("活锁不算失效，也不会被清", () => {
    plant({ pid: process.ppid });
    expect(staleLock(lock)).toBe(false);
    expect(clearStale(lock)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  test("死锁被认出来并清掉", () => {
    plant({ pid: 999_999 });
    expect(staleLock(lock)).toBe(true);
    expect(clearStale(lock)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
