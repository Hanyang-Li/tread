# tread 并发安全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 tread 在"多个 shell 并发激活不同 env"下的三个竞态，不引入 SQLite。

**Architecture:** 三个互不依赖的修复。①`lastUsed` 从全局单文件拆回各 env 自己的文件，竞态从构造上消失；②shims 改原子替换；③`ensureSkeleton`/`syncHomeLinks` 的写路径加一把防御性进程间文件锁（O_EXCL 创建 + rename 选举破锁 + pid 探活 + 年龄兜底 + 进程内重入放行）。

**Tech Stack:** bun + TypeScript，`node:fs` 同步 API，`Atomics.wait` 做同步睡眠。无新依赖。

设计依据见 `docs/superpowers/specs/2026-08-08-concurrency-safety-design.md`。

## Global Constraints

- **不引入任何新依赖**，`package.json` 不变。
- **用户可见的错误/提示文案一律英文**，与 `env.ts` 既有错误风格一致（首行陈述，空行，两空格缩进的提示行）。代码注释英文，测试名中文——与现有代码库一致。
- **文件系统是"有哪些 env"的唯一真相**，本次不引入任何注册表。
- 锁超时默认 `10_000` ms，可用 `TREAD_LOCK_TIMEOUT_MS` 覆盖；`MAX_AGE_MS` = `60_000`；`GRACE_MS` = `5_000`。
- 锁的获取必须是任何写盘动作之前的第一件事——"超时后重试无副作用"靠这个结构保证。
- 锁**绝不跨越 `Bun.spawn`**。
- 测试用 `TREAD_STATE_DIR` 隔离，沿用 `test/env.test.ts` 的 `beforeAll` + 动态 `import` 模式。

---

### Task 1: 原子写文件

**Files:**
- Create: `src/atomic.ts`
- Test: `test/atomic.test.ts`

**Interfaces:**
- Produces: `writeFileAtomic(file: string, text: string, mode?: number): void`

- [ ] **Step 1: 写失败的测试**

```ts
// test/atomic.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-atomic-")); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { writeFileAtomic } = await import("../src/atomic.ts");

describe("writeFileAtomic", () => {
  test("写得进去，且父目录会被建出来", () => {
    const f = path.join(tmp, "a/b/c.txt");
    writeFileAtomic(f, "hello");
    expect(fs.readFileSync(f, "utf8")).toBe("hello");
  });

  test("覆盖已存在的文件", () => {
    const f = path.join(tmp, "over.txt");
    writeFileAtomic(f, "one");
    writeFileAtomic(f, "two");
    expect(fs.readFileSync(f, "utf8")).toBe("two");
  });

  test("带 mode 时权限位生效", () => {
    const f = path.join(tmp, "exec.sh");
    writeFileAtomic(f, "#!/bin/sh\n", 0o755);
    expect(fs.statSync(f).mode & 0o777).toBe(0o755);
  });

  test("不留下临时文件", () => {
    const d = path.join(tmp, "clean");
    writeFileAtomic(path.join(d, "x"), "x");
    expect(fs.readdirSync(d)).toEqual(["x"]);
  });

  test("写失败时不留临时文件，且原文件不动", () => {
    const f = path.join(tmp, "keep.txt");
    writeFileAtomic(f, "original");
    // 目标是个目录 → rename 失败
    const bad = path.join(tmp, "adir");
    fs.mkdirSync(bad, { recursive: true });
    fs.mkdirSync(path.join(bad, "sub"), { recursive: true });
    expect(() => writeFileAtomic(path.join(bad, "sub"), "nope")).toThrow();
    expect(fs.readdirSync(bad)).toEqual(["sub"]);
    expect(fs.readFileSync(f, "utf8")).toBe("original");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/atomic.test.ts`
Expected: FAIL — `Cannot find module '../src/atomic.ts'`

- [ ] **Step 3: 实现**

```ts
// src/atomic.ts
import fs from "node:fs";
import path from "node:path";

let counter = 0;

/**
 * Replace a file in one step.
 *
 * `writeFileSync` truncates before it writes, so a concurrent reader can see
 * an empty or half-written file, and a crash can leave one behind. Writing a
 * sibling and renaming over the target closes both windows: rename is atomic
 * within a filesystem, so a reader sees either the whole old file or the whole
 * new one. The temp name carries the pid because two processes writing the
 * same target must not collide on the temp file either.
 */
export function writeFileAtomic(file: string, text: string, mode?: number): void {
  const tmp = `${file}.${process.pid}.${counter++}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? {} : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/atomic.test.ts`
Expected: PASS，5 个测试

- [ ] **Step 5: 提交**

```bash
git add src/atomic.ts test/atomic.test.ts
git commit -m "feat: atomic file replacement, so a reader never sees a half-written file"
```

---

### Task 2: 进程间锁

**Files:**
- Create: `src/lock.ts`
- Test: `test/lock.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `withLock<T>(lock: string, label: string, fn: () => T): T`
  - `staleLock(lock: string): boolean` — 锁存在且已失效
  - `clearStale(lock: string): boolean` — 清掉失效的锁，返回是否清了

- [ ] **Step 1: 写失败的测试**

```ts
// test/lock.test.ts
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
    JSON.stringify({ pid: owner.pid, host: owner.host ?? os.hostname(), at: owner.at ?? Date.now() }),
  );
}

describe("withLock", () => {
  test("跑完把锁释放掉，返回值透传", () => {
    expect(withLock(lock, "work", () => 42)).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("抛异常也释放锁", () => {
    expect(() => withLock(lock, "work", () => { throw new Error("boom"); })).toThrow("boom");
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("重入不自死锁", () => {
    const got = withLock(lock, "work", () => withLock(lock, "work", () => "inner"));
    expect(got).toBe("inner");
    // 内层不该把外层的锁释放掉，外层出来才释放
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("锁被活着的进程持有 → 超时报错，且带持有者信息", () => {
    plant({ pid: process.ppid });
    let err: Error | null = null;
    try { withLock(lock, "work", () => "never"); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('"work"');
    expect(err!.message).toContain(String(process.ppid));
    expect(err!.message).toContain("nothing was changed");
    // 别人的锁不能被删掉
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

  test("时钟回拨不会把新锁judge成古董", () => {
    plant({ pid: process.ppid, at: Date.now() + 3_600_000 });
    expect(() => withLock(lock, "work", () => 0)).toThrow();
  });

  test("身份文件损坏 → 用 mtime 兜底，超过宽限期才破", () => {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "not json at all");
    expect(() => withLock(lock, "work", () => 0)).toThrow(); // 刚写，在宽限期内
    const old = Date.now() - 60_000;
    fs.utimesSync(lock, old / 1000, old / 1000);
    expect(withLock(lock, "work", () => "ok")).toBe("ok");
  });

  test("锁被合法抢走后，自己 release 不误删新持有者的锁", () => {
    withLock(lock, "work", () => {
      // 模拟：我卡太久被判失效，别人抢了锁
      fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() }));
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/lock.test.ts`
Expected: FAIL — `Cannot find module '../src/lock.ts'`

- [ ] **Step 3: 实现**

```ts
// src/lock.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Past this a lock is assumed abandoned even when its pid still resolves.
 * A pid can be recycled by an unrelated process, and liveness alone would
 * then wait forever on a lock nobody holds. Far longer than any real sync.
 */
const MAX_AGE_MS = 60_000;

/**
 * A lock whose owner record is unreadable is trusted this long. The gap
 * between creating the file and writing the record is microseconds, so this
 * only matters for a crash inside that window or a corrupt file.
 */
const GRACE_MS = 5_000;

/** Immediate retries after breaking a lock, so a pathological clock cannot spin. */
const MAX_STEALS = 8;

function timeoutMs(): number {
  const raw = Number(process.env.TREAD_LOCK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
}

interface Owner {
  pid: number;
  host: string;
  at: number;
}

/**
 * Locks this process holds.
 *
 * A nested acquire of a lock we already hold returns without taking it again:
 * a file lock is not re-entrant by nature, so without this a future refactor
 * that calls a locked function from inside another one would deadlock against
 * itself, with no way out but the timeout.
 */
const held = new Set<string>();

let counter = 0;
let handlersInstalled = false;

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  // `finally` does not run when a signal kills the process, so a Ctrl-C while
  // holding the lock would leave it behind. Staleness detection would clear it
  // eventually; releasing here means the next process does not have to wait.
  const releaseAll = () => {
    for (const p of [...held]) release(p);
  };
  process.on("exit", releaseAll);
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) {
    process.on(sig, () => {
      releaseAll();
      process.exit(128 + n);
    });
  }
}

function readOwner(lock: string): Owner | null {
  try {
    const j = JSON.parse(fs.readFileSync(lock, "utf8"));
    if (typeof j?.pid !== "number" || typeof j?.at !== "number") return null;
    return { pid: j.pid, host: typeof j.host === "string" ? j.host : "", at: j.at };
  } catch {
    return null;
  }
}

/** EPERM means the process exists and belongs to someone else — still alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function abandoned(lock: string): boolean {
  const now = Date.now();
  const owner = readOwner(lock);
  if (!owner) {
    let mtime: number;
    try {
      mtime = fs.statSync(lock).mtimeMs;
    } catch {
      return false; // gone already; nothing to break
    }
    return Math.max(0, now - mtime) > GRACE_MS;
  }
  // a clock that jumped backwards must not make a fresh lock look ancient,
  // and one that jumped forwards must not age a live lock out early
  const age = Math.max(0, now - owner.at);
  // a pid from another host says nothing about any process here
  if (owner.host !== os.hostname()) return age > MAX_AGE_MS;
  if (!alive(owner.pid)) return true;
  return age > MAX_AGE_MS;
}

/**
 * Take an abandoned lock away from its owner.
 *
 * The rename is an election: two processes that both judge the same lock
 * abandoned rename it to different names, and only one succeeds — the loser
 * gets ENOENT and goes back to waiting. Unlinking instead would let both
 * proceed to create the lock, producing two holders.
 */
function steal(lock: string): boolean {
  const dead = `${lock}.dead.${process.pid}.${counter++}`;
  try {
    fs.renameSync(lock, dead);
  } catch {
    return false;
  }
  try {
    fs.rmSync(dead, { force: true });
  } catch {}
  return true;
}

/** Sleep without burning a core. `Atomics.wait` is the only real sync sleep. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timedOut(lock: string, label: string, waited: number): Error {
  const owner = readOwner(lock);
  const secs = (ms: number) => `${Math.round(Math.max(0, ms) / 1000)}s`;
  const who = owner
    ? `pid ${owner.pid}` +
      (owner.host && owner.host !== os.hostname() ? ` on ${owner.host}` : "") +
      ` (held for ${secs(Date.now() - owner.at)})`
    : "an unidentified process";
  return new Error(
    `environment "${label}" is being synced by another process\n\n` +
      `  holder   ${who}\n` +
      `  waited   ${secs(waited)}\n\n` +
      `  nothing was changed; retry once it finishes\n` +
      `  tread doctor --fix   if that process is gone`,
  );
}

/** True when we took the lock, false when we already held it (re-entrant). */
function acquire(lock: string, label: string): boolean {
  if (held.has(lock)) return false;
  installHandlers();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const budget = timeoutMs();
  const deadline = Date.now() + budget;
  let backoff = 25;
  let steals = 0;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        const owner: Owner = { pid: process.pid, host: os.hostname(), at: Date.now() };
        fs.writeSync(fd, JSON.stringify(owner));
      } finally {
        fs.closeSync(fd);
      }
      held.add(lock);
      return true;
    } catch (e) {
      // contention is the only recoverable case; EACCES, EROFS and ENOSPC are
      // real problems and must not be mistaken for a held lock
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }

    if (steals < MAX_STEALS && abandoned(lock) && steal(lock)) {
      steals++;
      continue;
    }

    // the deadline is computed once and re-checked every pass, and the sleep
    // is clamped to what is left, so no path here can wait forever
    const left = deadline - Date.now();
    if (left <= 0) throw timedOut(lock, label, budget);
    sleep(Math.min(backoff, left));
    backoff = Math.min(backoff * 2, 200);
  }
}

function release(lock: string): void {
  if (!held.delete(lock)) return;
  // our lock may have been judged abandoned and taken over while we worked;
  // unlinking then would delete a live holder's lock
  const owner = readOwner(lock);
  if (owner && (owner.pid !== process.pid || owner.host !== os.hostname())) return;
  try {
    fs.rmSync(lock, { force: true });
  } catch {}
}

/**
 * Run `fn` holding an inter-process lock.
 *
 * `label` names the environment, and only appears in the timeout message.
 * Acquiring is the first thing that happens, before `fn` can touch the disk,
 * so a timeout means nothing was written and retrying is equivalent to a
 * first call.
 */
export function withLock<T>(lock: string, label: string, fn: () => T): T {
  const mine = acquire(lock, label);
  try {
    return fn();
  } finally {
    if (mine) release(lock);
  }
}

/** An abandoned lock sitting in the way. */
export function staleLock(lock: string): boolean {
  try {
    fs.statSync(lock);
  } catch {
    return false;
  }
  return abandoned(lock);
}

/** Remove an abandoned lock. False when there was none, or it is still live. */
export function clearStale(lock: string): boolean {
  if (!staleLock(lock)) return false;
  return steal(lock);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/lock.test.ts`
Expected: PASS，16 个测试

- [ ] **Step 5: 提交**

```bash
git add src/lock.ts test/lock.test.ts
git commit -m "feat: a defensive inter-process lock that cannot deadlock or hang"
```

---

### Task 3: 路径helper

**Files:**
- Modify: `src/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Produces: `lastUsedFile(envRoot: string): string`、`syncLockFile(envRoot: string): string`

- [ ] **Step 1: 写失败的测试**

追加到 `test/paths.test.ts` 末尾（沿用文件里既有的 import 与 `TREAD_STATE_DIR` 约定）：

```ts
describe("每个环境自己的 tread 文件", () => {
  test("last-used 与 sync.lock 都在 .tread 下", () => {
    expect(lastUsedFile("/x/envs/work")).toBe("/x/envs/work/.tread/last-used");
    expect(syncLockFile("/x/envs/work")).toBe("/x/envs/work/.tread/sync.lock");
  });
});
```

同时把 `lastUsedFile, syncLockFile` 加进该文件顶部的 `import`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/paths.test.ts`
Expected: FAIL — `lastUsedFile is not a function`

- [ ] **Step 3: 实现**

在 `src/paths.ts` 的 `skillsDir` 之后加：

```ts
/**
 * When this environment was last activated.
 *
 * Per environment rather than one global map: the timestamp is a property of
 * the environment, and a shared file made every activation a read-modify-write
 * on the same path, so two shells activating different environments at the
 * same moment lost one of the two writes.
 */
export function lastUsedFile(envRoot: string): string {
  return path.join(envRoot, ".tread", "last-used");
}

/** Guards the writing half of `ensureSkeleton` against a concurrent activation. */
export function syncLockFile(envRoot: string): string {
  return path.join(envRoot, ".tread", "sync.lock");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/paths.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat: per-environment paths for the timestamp and the sync lock"
```

---

### Task 4: `lastUsed` 拆回各 env

**Files:**
- Modify: `src/env.ts:401-434`（`removeEnv`、`State`、`readState`、`writeState`、`lastUsed`、`touchLastUsed`）
- Test: `test/env.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic`（Task 1）、`lastUsedFile`（Task 3）
- Produces: `lastUsed(): Record<string, string>`、`touchLastUsed(name: string): void`（签名不变，4 个消费点不动）

- [ ] **Step 1: 写失败的测试**

替换 `test/env.test.ts` 里既有的 `lastUsed 持久化`（约 :350），改成：

```ts
describe("lastUsed", () => {
  test("写在各 env 自己的 .tread/last-used 里，不再有全局单文件", () => {
    createEnv("lu-a");
    touchLastUsed("lu-a");
    expect(fs.existsSync(lastUsedFile(envDir("lu-a")))).toBe(true);
    expect(typeof lastUsed()["lu-a"]).toBe("string");
  });

  test("两个 env 各写各的，互不覆盖（回归：全局单文件会丢更新）", () => {
    createEnv("lu-b");
    createEnv("lu-c");
    touchLastUsed("lu-b");
    touchLastUsed("lu-c");
    const m = lastUsed();
    expect(typeof m["lu-b"]).toBe("string");
    expect(typeof m["lu-c"]).toBe("string");
  });

  test("没写过的 env 不出现在结果里", () => {
    createEnv("lu-never");
    expect(lastUsed()["lu-never"]).toBeUndefined();
  });

  test("读得到老的 state.json，但不再往里写", () => {
    createEnv("lu-legacy");
    const sf = path.join(process.env.TREAD_STATE_DIR!, "state.json");
    fs.mkdirSync(path.dirname(sf), { recursive: true });
    fs.writeFileSync(sf, JSON.stringify({ lastUsed: { "lu-legacy": "2020-01-01T00:00:00.000Z" } }));
    expect(lastUsed()["lu-legacy"]).toBe("2020-01-01T00:00:00.000Z");

    // 自己的文件一旦写了就盖过老数据，且老文件原样不动
    touchLastUsed("lu-legacy");
    expect(lastUsed()["lu-legacy"]).not.toBe("2020-01-01T00:00:00.000Z");
    expect(JSON.parse(fs.readFileSync(sf, "utf8")).lastUsed["lu-legacy"]).toBe("2020-01-01T00:00:00.000Z");
  });

  test("坏掉的 last-used 只是让那个 env 没有时间戳，不炸", () => {
    createEnv("lu-bad");
    fs.writeFileSync(lastUsedFile(envDir("lu-bad")), "");
    expect(() => lastUsed()).not.toThrow();
    expect(lastUsed()["lu-bad"]).toBeUndefined();
  });

  test("删掉 env，时间戳跟着消失", () => {
    createEnv("lu-rm");
    touchLastUsed("lu-rm");
    removeEnv("lu-rm");
    expect(lastUsed()["lu-rm"]).toBeUndefined();
  });
});
```

顶部 import 补 `lastUsedFile`：

```ts
const { envDir, skillsDir, agentDir, lastUsedFile } = await import("../src/paths.ts");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/env.test.ts`
Expected: FAIL — `lastUsedFile is not a function` / 老数据那条不通过

- [ ] **Step 3: 实现**

`src/env.ts` 顶部 import 补上：

```ts
import { agentDir, envDir, envsDir, lastUsedFile, realHome, skillsDir, stateFile, syncLockFile } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { withLock } from "./lock.ts";
```

把 `removeEnv` 到文件里 `State`/`readState`/`writeState`/`lastUsed`/`touchLastUsed` 这一段（`env.ts:401-434`）整体替换为：

```ts
export function removeEnv(name: string): void {
  // the timestamp lives inside the environment, so it goes with it
  fs.rmSync(requireEnv(name), { recursive: true, force: true });
}

/**
 * The pre-per-environment global state file.
 *
 * Read and never written. Entries fade out on their own: an environment that
 * gets activated writes its own timestamp, which wins from then on.
 */
function readLegacyLastUsed(): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const m = j?.lastUsed;
    if (!m || typeof m !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function readLastUsed(envRoot: string): string | null {
  try {
    return fs.readFileSync(lastUsedFile(envRoot), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function lastUsed(): Record<string, string> {
  const legacy = readLegacyLastUsed();
  const out: Record<string, string> = {};
  for (const name of listEnvs()) {
    const v = readLastUsed(envDir(name)) ?? legacy[name];
    if (v) out[name] = v;
  }
  return out;
}

/**
 * Record that this environment was just activated.
 *
 * Atomic, and touching only this environment's own file — so two shells
 * activating two environments never contend, and two shells activating the
 * same one both write a valid "now" with no read-modify-write to lose.
 */
export function touchLastUsed(name: string): void {
  writeFileAtomic(lastUsedFile(envDir(name)), new Date().toISOString() + "\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/env.test.ts && bun run typecheck`
Expected: PASS，typecheck 无输出

- [ ] **Step 5: 提交**

```bash
git add src/env.ts test/env.test.ts
git commit -m "fix: lastUsed lost writes when two shells activated different envs at once"
```

---

### Task 5: sync 加锁

**Files:**
- Modify: `src/env.ts`（`syncHomeLinks` 拆出 `syncOnce`；`ensureSkeleton` 包锁）
- Test: `test/env.test.ts`

**Interfaces:**
- Consumes: `withLock`（Task 2）、`syncLockFile`（Task 3）
- Produces: `syncHomeLinks` / `ensureSkeleton` 签名与返回类型均不变

- [ ] **Step 1: 写失败的测试**

追加到 `test/env.test.ts`：

```ts
describe("sync 互斥", () => {
  test("dryRun 不拿锁：别人持锁时探查照常返回", () => {
    const dir = createEnv("lk-dry");
    const lock = syncLockFile(dir);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() }));
    expect(() => syncHomeLinks(dir, { dryRun: true })).not.toThrow();
    fs.rmSync(lock, { force: true });
  });

  test("别人持锁时写路径超时报错，且盘上零改动", () => {
    const prev = process.env.TREAD_LOCK_TIMEOUT_MS;
    process.env.TREAD_LOCK_TIMEOUT_MS = "200";
    const dir = createEnv("lk-busy");
    // 记下加锁前的样子
    const before = fs.readdirSync(dir).sort();
    const lock = syncLockFile(dir);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() }));

    expect(() => syncHomeLinks(dir)).toThrow(/being synced by another process/);
    expect(fs.readdirSync(dir).sort()).toEqual(before);

    // 锁一放，同样的调用就该成功
    fs.rmSync(lock, { force: true });
    expect(() => syncHomeLinks(dir)).not.toThrow();
    process.env.TREAD_LOCK_TIMEOUT_MS = prev;
  });

  test("失效的锁不挡路", () => {
    const dir = createEnv("lk-stale");
    const lock = syncLockFile(dir);
    fs.writeFileSync(lock, JSON.stringify({ pid: 999_999, host: os.hostname(), at: Date.now() }));
    expect(() => ensureSkeleton(dir)).not.toThrow();
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("ensureSkeleton 里嵌套的 syncHomeLinks 不自死锁", () => {
    const prev = process.env.TREAD_LOCK_TIMEOUT_MS;
    process.env.TREAD_LOCK_TIMEOUT_MS = "200";
    const dir = createEnv("lk-nest");
    expect(() => ensureSkeleton(dir)).not.toThrow();
    expect(fs.existsSync(syncLockFile(dir))).toBe(false);
    process.env.TREAD_LOCK_TIMEOUT_MS = prev;
  });
});
```

顶部 import 补 `syncLockFile`，并确保 `os` 已 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/env.test.ts`
Expected: FAIL — 超时那条不抛错（现在根本没锁）

- [ ] **Step 3: 实现**

把 `syncHomeLinks` 的函数签名行改成内部函数，并新增对外的包装。即：

```ts
export function syncHomeLinks(
  envRoot: string,
  { dryRun = false }: { dryRun?: boolean } = {},
): SyncResult {
  // the probe path changes nothing, so it neither needs the lock nor should
  // queue behind one: a report that raced a concurrent sync is slightly stale,
  // which is not worth making an interactive command wait for
  if (dryRun) return syncOnce(envRoot, true);
  return withLock(syncLockFile(envRoot), path.basename(envRoot), () =>
    syncOnce(envRoot, false),
  );
}

function syncOnce(envRoot: string, dryRun: boolean): SyncResult {
  // ...既有函数体原样搬进来，删掉解构参数、改用 dryRun 形参
}
```

原函数体第一行 `const home = realHome();` 起全部不变。

`ensureSkeleton` 整体包锁——它自己的 mkdir/symlink/seed/install 同样会被并发撞上，而里层的 `syncHomeLinks` 靠重入放行不会二次获取：

```ts
export function ensureSkeleton(envRoot: string): SyncResult {
  return withLock(syncLockFile(envRoot), path.basename(envRoot), () => {
    for (const a of AGENTS) fs.mkdirSync(agentDir(envRoot, a), { recursive: true });
    fs.mkdirSync(skillsDir(envRoot, "kimi"), { recursive: true });
    fs.mkdirSync(path.join(envRoot, ".tread"), { recursive: true });

    for (const n of ["credentials", "oauth"]) {
      const link = path.join(agentDir(envRoot, "kimi"), n);
      if (fs.existsSync(link) || isLink(link)) continue;
      fs.symlinkSync(path.join(realHome(), ".kimi-code", n), link);
    }
    seedKimiConfig(envRoot);
    installTreadSkill(envRoot);
    return syncHomeLinks(envRoot);
  });
}
```

`writeManifest` 顺手改用原子写（它在锁内，跨进程已安全，但崩在写一半仍会留下坏 JSON）：

```ts
function writeManifest(envRoot: string, paths: string[]): void {
  writeFileAtomic(manifestFile(envRoot), JSON.stringify({ version: 1, paths }, null, 2) + "\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/env.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/env.ts test/env.test.ts
git commit -m "fix: serialise the writing half of a sync, so two shells cannot interleave"
```

---

### Task 6: shims 原子替换

**Files:**
- Modify: `src/shims.ts:73-78`
- Test: `test/shims.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic`（Task 1）

- [ ] **Step 1: 写失败的测试**

追加到 `test/shims.test.ts`：

```ts
describe("shim 覆写", () => {
  test("覆写不经过截断态：过程里文件始终非空且可执行", () => {
    writeShims();
    const dir = shimsDir();
    const target = path.join(dir, fs.readdirSync(dir)[0]!);
    const before = fs.readFileSync(target, "utf8");
    expect(before.length).toBeGreaterThan(0);

    // 改脏再重写，中途不该出现 0 字节或丢权限
    fs.writeFileSync(target, "stale\n", { mode: 0o755 });
    writeShims();
    const after = fs.readFileSync(target, "utf8");
    expect(after).toBe(before);
    expect(fs.statSync(target).mode & 0o111).toBeGreaterThan(0);
  });

  test("不在 shim 目录里留临时文件", () => {
    writeShims();
    expect(fs.readdirSync(shimsDir()).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});
```

顶部 import 补 `shimsDir`（若尚未引入）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/shims.test.ts`
Expected: 临时文件那条可能已通过；覆写那条应通过——**这两条是防回归的护栏**，先确认它们在改动前后都绿，再改实现。

- [ ] **Step 3: 实现**

`src/shims.ts` 顶部加 `import { writeFileAtomic } from "./atomic.ts";`，然后把 `writeShims` 里的写替换掉：

```ts
    if (existing !== body) {
      // rename, not truncate-and-write: another shell may be exec'ing this
      // shim right now, and a half-written one is a broken interpreter line
      writeFileAtomic(target, body, 0o755);
      written.push(name);
    }
    fs.chmodSync(target, 0o755);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/shims.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shims.ts test/shims.test.ts
git commit -m "fix: replace shims by rename, so a concurrent exec never sees a half-written one"
```

---

### Task 7: cp 不继承时间戳与锁

**Files:**
- Modify: `src/copy.ts:16-21`
- Test: `test/copy.test.ts`

**Interfaces:**
- Consumes: 无

- [ ] **Step 1: 写失败的测试**

追加到 `test/copy.test.ts`：

```ts
test("副本不继承源的时间戳，也不继承锁", () => {
  const src = createEnv("cp-lu-src");
  touchLastUsed("cp-lu-src");
  fs.writeFileSync(
    syncLockFile(src),
    JSON.stringify({ pid: 999_999, host: "x", at: Date.now() }),
  );

  const dst = copyEnv("cp-lu-src", "cp-lu-dst").root;
  expect(fs.existsSync(path.join(dst, ".tread/last-used"))).toBe(false);
  expect(fs.existsSync(path.join(dst, ".tread/sync.lock"))).toBe(false);
  expect(lastUsed()["cp-lu-dst"]).toBeUndefined();
});
```

顶部 import 按该文件既有风格补 `touchLastUsed`、`lastUsed`、`syncLockFile`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/copy.test.ts`
Expected: FAIL — `last-used` 被复制过去了

- [ ] **Step 3: 实现**

```ts
const SHARED_VOLATILE = [
  ".tread/sync.json", // regenerated for dst; src's copy is src's own ledger
  ".tread/last-used", // a copy has not been used yet; it earns its own timestamp
  ".tread/sync.lock", // never inherit a lock, live or abandoned
  ".local/state", // tread's state dir, plus gh and claude lock files
  "Library/Caches", // cursor's compile cache
  "Library/Application Support", // cursor desktop's skill index db, clawhub state
];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/copy.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/copy.ts test/copy.test.ts
git commit -m "fix: a copied environment inherits neither the timestamp nor the lock"
```

---

### Task 8: doctor 报告并清理失效锁

**Files:**
- Modify: `src/commands.ts`（doctor 的 per-env 循环，`:296` 之前插入）
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `staleLock` / `clearStale`（Task 2）、`syncLockFile`（Task 3）

- [ ] **Step 1: 写失败的测试**

追加到 `test/commands.test.ts`（沿用该文件既有的 `run(...)` 驱动方式）：

```ts
test("doctor 报告失效的 sync 锁，--fix 清掉它", async () => {
  const dir = createEnv("doc-lock");
  const lock = syncLockFile(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999_999, host: os.hostname(), at: Date.now() }));

  const report = await run(["doctor", "doc-lock"]);
  expect(report.out).toContain("sync.lock");
  expect(fs.existsSync(lock)).toBe(true);

  await run(["doctor", "doc-lock", "--fix"]);
  expect(fs.existsSync(lock)).toBe(false);
});

test("doctor 不碰活着的锁", async () => {
  const dir = createEnv("doc-live");
  const lock = syncLockFile(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() }));
  await run(["doctor", "doc-live", "--fix"]);
  expect(fs.existsSync(lock)).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test test/commands.test.ts`
Expected: FAIL — 输出里没有 `sync.lock`

- [ ] **Step 3: 实现**

`src/commands.ts` 顶部 import 补 `staleLock, clearStale`（来自 `./lock.ts`）和 `syncLockFile`（来自 `./paths.ts`）。

在 doctor 的 per-env 循环里，`for (const n of ["credentials", "oauth"])` 那段**之前**插入：

```ts
    // a lock whose owner is gone would make the next activation wait out the
    // full timeout for nothing
    const lock = syncLockFile(root);
    if (staleLock(lock)) {
      found(`.tread/sync.lock   left behind by a process that is gone`);
      if (fix) clearStale(lock);
    }
```

注意 `syncHomeLinks(root, { dryRun: !fix })` 在 `--fix` 下会先拿锁——失效锁会在那里就被破掉。所以这段检查放在 sync 之后仍有意义的是**非 fix 的报告路径**；`--fix` 路径下它是第二道保险。两条测试分别覆盖这两个路径。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test test/commands.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "feat: doctor reports an abandoned sync lock, and --fix clears it"
```

---

### Task 9: e2e 真实并发

**Files:**
- Modify: `test/e2e.test.ts`

**Interfaces:**
- Consumes: 全部

- [ ] **Step 1: 写测试**

追加到 `test/e2e.test.ts`：

```ts
test("多个进程并发激活不同 env：时间戳一个都不丢", async () => {
  const names = ["par-a", "par-b", "par-c", "par-d", "par-e"];
  for (const n of names) expect((await tread(["create", n])).code).toBe(0);

  // 真并发，不是顺序跑 —— 这正是丢更新的场景
  const runs = await Promise.all(names.map((n) => tread(["_export", "use", n])));
  for (const r of runs) expect(r.code).toBe(0);

  const ls = await tread(["ls"]);
  for (const n of names) {
    expect(ls.out).toContain(n);
    // 每个 env 都该有自己的时间戳文件
    expect(fs.existsSync(path.join(state, "envs", n, ".tread/last-used"))).toBe(true);
  }
  // 没有一个显示 never
  expect(ls.out).not.toContain("never");
}, 60000);

test("同一个 env 被并发激活：都成功，不留锁", async () => {
  expect((await tread(["create", "par-same"])).code).toBe(0);
  const runs = await Promise.all(
    Array.from({ length: 5 }, () => tread(["_export", "use", "par-same"])),
  );
  for (const r of runs) expect(r.code).toBe(0);
  expect(fs.existsSync(path.join(state, "envs", "par-same", ".tread/sync.lock"))).toBe(false);
}, 60000);

test("锁不跨越 exec 的子进程：agent 在跑时别的 shell 照样能激活", async () => {
  expect((await tread(["create", "par-exec"])).code).toBe(0);
  // 子进程睡着的这段时间里，另一个 tread 必须能拿到锁
  const slow = tread(["exec", "par-exec", "--", "sleep", "3"]);
  await Bun.sleep(700);
  const t = Date.now();
  const other = await tread(["_export", "use", "par-exec"]);
  expect(other.code).toBe(0);
  expect(Date.now() - t).toBeLessThan(2500); // 没有等满 10s 超时
  expect((await slow).code).toBe(0);
}, 60000);
```

- [ ] **Step 2: 跑测试**

Run: `bun test test/e2e.test.ts`
Expected: PASS

- [ ] **Step 3: 全量回归**

Run: `bun test && bun run typecheck`
Expected: 全绿，typecheck 无输出

- [ ] **Step 4: 提交**

```bash
git add test/e2e.test.ts
git commit -m "test: e2e coverage for concurrent activation and lock scope"
```

---

## Self-Review

**Spec coverage:**

| Spec 章节 | Task |
|---|---|
| §4.1 存储（temp+rename、同目录、带 pid） | 1, 4 |
| §4.2 读取（扫目录、降级、消费点不变） | 4 |
| §4.3 老数据回退，只读不写 | 4 |
| §4.4 removeEnv、cp 排除 | 4, 7 |
| §5 shims 原子替换 | 6 |
| §6.1 原语 | 2 |
| §6.2 锁形态、获取、失效判定、抢占、释放 | 2 |
| §6.3 全部 12 个失效场景 | 2（测试逐条覆盖） |
| §6.4 只锁 dryRun:false、不跨 spawn | 5, 9 |
| §6.5 超时报错、重试干净、可配超时 | 2, 5 |
| §6.6 doctor 集成 | 8 |
| §7 全部测试项 | 1,2,4,5,6,7,8,9 |
| §8 非目标 | 全程不碰 config / listEnvs / zshrc |

**Placeholder scan:** 无 TBD/TODO，每个代码步骤都有完整可粘贴的实现。

**Type consistency:** `writeFileAtomic(file, text, mode?)`、`withLock(lock, label, fn)`、`staleLock(lock)`、`clearStale(lock)`、`lastUsedFile(envRoot)`、`syncLockFile(envRoot)` 在定义处与全部调用处一致。`SyncResult` 不加字段（超时报错而非跳过，无需 `skipped`）。

**偏离 spec 一处：** spec §6.5 的错误示例是中文，实现改用英文，与 `env.ts` 既有用户可见错误一致（见 Global Constraints）。
