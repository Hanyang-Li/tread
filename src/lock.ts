import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Past this a lock is assumed abandoned even when its pid still resolves.
 *
 * A pid can be recycled by an unrelated process, and liveness alone would then
 * wait forever on a lock nobody holds. Far longer than any real sync takes.
 */
const MAX_AGE_MS = 60_000;

/**
 * How long a lock whose owner record is unreadable is still trusted.
 *
 * The gap between creating the file and writing the record is microseconds, so
 * this only matters for a crash inside that window, or a corrupt file.
 */
const GRACE_MS = 5_000;

/** Immediate retries after breaking a lock, so a broken clock cannot spin. */
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
 * A nested acquire of a lock we already hold returns without taking it again.
 * A file lock is not re-entrant by nature, so without this a future refactor
 * that called a locked function from inside another one would deadlock against
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
  // eventually; releasing here means the next process never has to wait.
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
      return false; // gone already; there is nothing to break
    }
    return Math.max(0, now - mtime) > GRACE_MS;
  }
  // a clock that jumped backwards must not make a fresh lock look ancient
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
 * gets ENOENT and goes back to waiting. Unlinking instead would let both go on
 * to create the lock, producing two holders.
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
      // real problems and must never be mistaken for a held lock
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }

    if (steals < MAX_STEALS && abandoned(lock) && steal(lock)) {
      steals++;
      continue;
    }

    // the deadline is computed once and re-checked on every pass, and the
    // sleep is clamped to what is left, so no path here can wait forever
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
 * `label` names the environment and only appears in the timeout message.
 * Acquiring is the first thing that happens, before `fn` can touch the disk,
 * so a timeout means nothing was written and a retry is equivalent to a first
 * call.
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
