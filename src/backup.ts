import fs from "node:fs";
import path from "node:path";
import { AGENTS, AGENT_SPECS, type Agent } from "./agents.ts";
import { writeFileAtomic, replaceSymlinkAtomic } from "./atomic.ts";
import { stateDir, underEnvs } from "./paths.ts";

/**
 * A copy of each agent's binary, kept where the agent cannot reach it.
 *
 * The failure this exists for is in the user's home right now: claude's
 * updater left `~/.local/share/claude/versions/2.1.241` as a 0-byte file, and
 * the launcher symlink pointed at it. Nothing tread does causes this and no
 * `DISABLE_AUTOUPDATER` prevents it — the update simply failed halfway, and
 * what is left is a name on PATH with nothing behind it.
 *
 * The copy is an APFS clone, not a hard link. A hard link shares the inode, so
 * an updater that overwrites in place takes the backup with it; a clone gets
 * its own inode and survives the original being truncated to zero. It also
 * costs no disk while the original is still there — the blocks are shared
 * until one side is written — and it is the only one of the two that can
 * cover a whole directory, which cursor-agent needs: its `cursor-agent` is a
 * 1.1k shell script and the 224MB it depends on sits beside it.
 *
 * macOS only. clonefile is an APFS call; `cp -c` fails rather than silently
 * falling back to a real copy, which is what we want — a backup that quietly
 * costs 780MB is worse than no backup.
 */

/** Fixed name for the copy, and deliberately not the agent's own.
 *
 * A directory holding a file called `claude` is one stray PATH entry away from
 * being the `claude` every shell runs — the exact bug `realBinary` and
 * `stray.ts` exist to undo. Nothing can resolve `payload` by accident.
 */
const PAYLOAD = "payload";
const MANIFEST = "manifest.json";

export type BackupKind = "file" | "tree";

export interface BackupManifest {
  agent: Agent;
  kind: BackupKind;
  /** what was cloned: the version file, or the directory holding it */
  origin: string;
  /** the name on PATH that reaches it */
  launcher: string;
  /**
   * Where `launcher` pointed when it was a symlink, or null when the launcher
   * is the binary itself. Restoring the payload is only half the repair —
   * claude's launcher is `~/.local/bin/claude -> …/versions/<v>`, and putting
   * the version file back without repointing the link leaves the same dangling
   * name it started with.
   */
  linkTarget: string | null;
  bytes: number;
  /**
   * When the binary was built, as an ISO string.
   *
   * The only handle on *which* build this is for an agent that has no version
   * directory: claude and cursor-agent name theirs (`2.1.245`), while kimi
   * installs straight to `~/.kimi-code/bin/kimi`, where the basename is just
   * the word "kimi" and says nothing at all.
   */
  mtime?: string;
  /**
   * Why the clone failed, when it did.
   *
   * Recorded rather than thrown away, and the manifest is written either way:
   * its mtime is what the shim compares against to decide whether to try
   * again, so a failure that wrote nothing would have every single launch
   * paying for the same doomed attempt.
   */
  error?: string;
}

export interface BackupStatus {
  agent: Agent;
  manifest: BackupManifest | null;
  /** the copy is actually on disk, not just described by a manifest */
  present: boolean;
  /** what the manifest describes is still the version installed today */
  current: boolean;
}

export function backupsDir(): string {
  return path.join(stateDir(), "binaries");
}

export function backupDir(agent: Agent): string {
  return path.join(backupsDir(), agent);
}

/** The manifest doubles as the shim's timestamp; see BackupManifest.error. */
export function backupStampFile(agent: Agent): string {
  return path.join(backupDir(agent), MANIFEST);
}

function payloadPath(agent: Agent): string {
  return path.join(backupDir(agent), PAYLOAD);
}

/**
 * What an agent keeps beside its binary, and therefore what has to be copied.
 *
 * claude and kimi are single self-contained files. cursor-agent is not: the
 * executable on PATH is a shell script that loads the js bundle sitting next
 * to it, so copying the script alone backs up a note saying where the program
 * used to be.
 */
function kindOf(agent: Agent): BackupKind {
  return agent === "cursor" ? "tree" : "file";
}

/** `cp -c`, which is clonefile(2) or an error — never a silent 224MB copy. */
function clone(src: string, dst: string, kind: BackupKind): string | null {
  const r = Bun.spawnSync(["cp", ...(kind === "tree" ? ["-Rc"] : ["-c"]), src, dst], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode === 0) return null;
  const msg = new TextDecoder().decode(r.stderr).trim();
  return msg || `cp exited ${r.exitCode}`;
}

function sizeOf(p: string, kind: BackupKind): number {
  if (kind === "file") return fs.statSync(p).size;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    try {
      total += fs.statSync(path.join(e.parentPath, e.name)).size;
    } catch {}
  }
  return total;
}

/**
 * Replace the payload in as few steps as possible.
 *
 * rename onto an existing directory fails with ENOTEMPTY, so the old copy is
 * moved aside first. That leaves a window where the payload is missing, which
 * is survivable here for the reason it would not be for a shim: nothing
 * resolves this path, so the worst case is `doctor` reporting no backup for a
 * few milliseconds.
 */
function swapPayload(tmp: string, dst: string): void {
  const old = `${dst}.${process.pid}.old`;
  let moved = false;
  if (fs.existsSync(dst)) {
    fs.renameSync(dst, old);
    moved = true;
  }
  try {
    fs.renameSync(tmp, dst);
  } catch (e) {
    if (moved) fs.renameSync(old, dst);
    throw e;
  }
  if (moved) fs.rmSync(old, { recursive: true, force: true });
}

/**
 * Resolve what the shim handed us into the thing worth copying.
 *
 * `real` is a name on PATH — usually a symlink into a versions directory. What
 * we want is the file it lands on, and for cursor the directory that file
 * lives in.
 */
function resolveOrigin(agent: Agent, real: string): { origin: string; linkTarget: string | null } {
  const resolved = fs.realpathSync(real);
  const linkTarget = fs.lstatSync(real).isSymbolicLink()
    ? path.resolve(path.dirname(real), fs.readlinkSync(real))
    : null;
  return { origin: kindOf(agent) === "tree" ? path.dirname(resolved) : resolved, linkTarget };
}

/**
 * Clone the installed binary into the state dir. Never throws.
 *
 * Called by the shim on the launches where the binary has changed, in the
 * background, so nothing here may be allowed to reach the user's terminal or
 * hold up the agent it is copying.
 */
export function captureBinary(agent: Agent, real: string): BackupManifest {
  const dir = backupDir(agent);
  const kind = kindOf(agent);
  const write = (m: BackupManifest) => {
    try {
      writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify(m, null, 2) + "\n");
    } catch {}
    return m;
  };
  const fail = (origin: string, launcher: string, error: string): BackupManifest =>
    write({ agent, kind, origin, launcher, linkTarget: null, bytes: 0, error });

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // nowhere to write the manifest either, so there is no way to record this
    return { agent, kind, origin: real, launcher: real, linkTarget: null, bytes: 0, error: "state dir unwritable" };
  }

  let origin: string;
  let linkTarget: string | null;
  try {
    ({ origin, linkTarget } = resolveOrigin(agent, real));
  } catch (e) {
    return fail(real, real, `cannot resolve ${real}`);
  }

  // Never back up a copy living inside an environment. One that got there is
  // the bug `findInEnvBinaries` reports and `--fix` deletes, and preserving it
  // here would make that copy outlive the deletion meant to get rid of it.
  // `origin` has been through realpath and the state dir may be behind a
  // symlink, so this has to be asked of both spellings — see envsDirSpellings.
  if (underEnvs(origin)) {
    return fail(origin, real, "inside an environment");
  }

  // The 0-byte case is the whole point: a failed update leaves exactly this,
  // and copying it over a good backup would destroy the one thing that could
  // have repaired it.
  let bytes: number;
  let mtime: string;
  try {
    bytes = sizeOf(origin, kind);
    mtime = fs.statSync(origin).mtime.toISOString();
  } catch (e) {
    return fail(origin, real, `cannot stat ${origin}`);
  }
  if (bytes === 0) return fail(origin, real, "nothing to copy");

  const dst = payloadPath(agent);
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const err = clone(origin, tmp, kind);
  if (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(origin, real, err);
  }
  try {
    swapPayload(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(origin, real, `cannot replace the copy: ${(e as Error).message}`);
  }
  return write({ agent, kind, origin, launcher: real, linkTarget, bytes, mtime });
}

function readManifest(agent: Agent): BackupManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(backupDir(agent), MANIFEST), "utf8"));
    return typeof m?.origin === "string" ? (m as BackupManifest) : null;
  } catch {
    return null;
  }
}

/**
 * What is backed up right now, for every agent.
 *
 * `current` is answered against the binary on PATH today rather than against
 * the manifest alone: a backup of a version that has since been replaced is
 * still a working binary and still worth reporting, but it is not the thing
 * the user is running, and a status line that conflated the two would call a
 * three-versions-old copy "ok".
 */
export function listBackups(realOf: (bin: string) => string | null): BackupStatus[] {
  return AGENTS.map((agent) => {
    const manifest = readManifest(agent);
    const present = manifest !== null && !manifest.error && fs.existsSync(payloadPath(agent));
    let current = false;
    if (manifest && present) {
      const real = realOf(AGENT_SPECS[agent].bin);
      try {
        current = real !== null && resolveOrigin(agent, real).origin === manifest.origin;
      } catch {}
    }
    return { agent, manifest, present, current };
  });
}

/** Total bytes the backups occupy — see the note in `doctor` about du. */
export function backupBytes(list: BackupStatus[]): number {
  return list.reduce((n, b) => n + (b.present ? (b.manifest?.bytes ?? 0) : 0), 0);
}

/**
 * Put a backed-up binary back where it came from.
 *
 * Both halves, because either alone leaves the command broken: the payload is
 * cloned back to `origin`, and the launcher symlink is repointed at what it
 * used to name. The second matters even when the first succeeds — a failed
 * update that left a 0-byte version file usually left the launcher pointing at
 * *that* version, so restoring the older one silently and stopping would fix
 * nothing anybody can run.
 */
export function restoreBinary(agent: Agent): { ok: boolean; error?: string } {
  const m = readManifest(agent);
  if (!m || m.error) return { ok: false, error: "no backup" };
  const src = payloadPath(agent);
  if (!fs.existsSync(src)) return { ok: false, error: "backup is gone" };

  try {
    fs.mkdirSync(path.dirname(m.origin), { recursive: true });
    // whatever is standing there is what could not be run; it is what we were
    // asked to replace, so it goes
    fs.rmSync(m.origin, { recursive: true, force: true });
    const err = clone(src, m.origin, m.kind);
    if (err) return { ok: false, error: err };
    if (m.linkTarget) replaceSymlinkAtomic(m.linkTarget, m.launcher);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
