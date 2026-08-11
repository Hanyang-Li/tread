import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, AGENT_SPECS } from "./agents.ts";
import {
  agentDir, envDir, envsDir, isolateLoginFile, lastUsedFile, realHome, skillsDir,
  stateFile, syncLockFile,
} from "./paths.ts";
import { hardDeny, resolveConfig, type ConfigProblem } from "./config.ts";
import { installTreadSkill } from "./skill.ts";
import { writeFileAtomic } from "./atomic.ts";
import { withLock } from "./lock.ts";

/** Entries tread itself writes into an agent dir when creating the skeleton. */
export const SKELETON_ENTRIES = new Set(["config.toml", "credentials", "oauth"]);

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Exists on disk, symlink or not — `existsSync` would call a dangling link absent. */
function realExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

interface Node {
  allow: boolean;
  deny: boolean;
  /** a strict descendant is denied, so this level must be mirrored not linked */
  denyBelow: boolean;
  /** a strict descendant is allowed, so this level is worth descending into */
  allowBelow: boolean;
  children: Map<string, Node>;
}

function emptyNode(): Node {
  return {
    allow: false,
    deny: false,
    denyBelow: false,
    allowBelow: false,
    children: new Map(),
  };
}

function insert(root: Node, rel: string, mark: "allow" | "deny"): void {
  let node = root;
  for (const part of rel.split("/")) {
    let next = node.children.get(part);
    if (!next) {
      next = emptyNode();
      node.children.set(part, next);
    }
    node = next;
  }
  node[mark] = true;
}

function annotate(node: Node): { deny: boolean; allow: boolean } {
  let denyBelow = false;
  let allowBelow = false;
  for (const child of node.children.values()) {
    const sub = annotate(child);
    if (sub.deny || child.deny) denyBelow = true;
    if (sub.allow || child.allow) allowBelow = true;
  }
  node.denyBelow = denyBelow;
  node.allowBelow = allowBelow;
  return { deny: denyBelow, allow: allowBelow };
}

/** Combined allow/deny tree. Deny is applied on top and always wins. */
function policyTree(allow: string[], deny: string[]): Node {
  const root = emptyNode();
  for (const p of allow) insert(root, p, "allow");
  for (const p of deny) insert(root, p, "deny");
  annotate(root);
  return root;
}

/** True when `link` is a symlink tread created into the real home. */
function pointsIntoHome(link: string): boolean {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    return fs.readlinkSync(link).startsWith(realHome() + path.sep);
  } catch {
    return false;
  }
}

/** Whether linking `target` at `link` would change anything. */
function wouldLink(target: string, link: string): boolean {
  // a real file or directory in the env always wins
  if (fs.existsSync(link) && !isLink(link)) return false;
  if (isLink(link)) return fs.readlinkSync(link) !== target;
  return true;
}

function linkInto(target: string, link: string): boolean {
  if (!wouldLink(target, link)) return false;
  if (isLink(link)) fs.rmSync(link, { force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
  return true;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * What tread created in this env last time.
 *
 * Kept so a path dropped from the allow list can actually be removed. Without
 * it, tightening the configuration would be a no-op on existing environments —
 * the config would say "no longer shared" while the link stayed put, which is
 * the worst way for an allow list to fail.
 */
function manifestFile(envRoot: string): string {
  return path.join(envRoot, ".tread", "sync.json");
}

function readManifest(envRoot: string): string[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(manifestFile(envRoot), "utf8"));
    return Array.isArray(j?.paths) ? j.paths.filter((p: unknown) => typeof p === "string") : null;
  } catch {
    return null;
  }
}

function writeManifest(envRoot: string, paths: string[]): void {
  // atomic even though the lock already serialises writers: a crash halfway
  // through would otherwise leave JSON that only `discoverExisting` can undo
  writeFileAtomic(manifestFile(envRoot), JSON.stringify({ version: 1, paths }, null, 2) + "\n");
}

function isDenied(rel: string, root: Node): boolean {
  let node: Node | undefined = root;
  for (const part of rel.split("/")) {
    node = node.children.get(part);
    if (!node) return false;
    if (node.deny) return true;
  }
  return false;
}

/**
 * Reconstruct the manifest for an environment created before it existed, by
 * finding what tread would have left behind: symlinks into the real home, and
 * the directories that hold them. Bounded by depth and by skipping the agent
 * dirs, so it never walks into whatever the agent itself put in the env.
 */
function discoverExisting(envRoot: string, tree: Node): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number): boolean => {
    if (depth > 8) return false;
    let any = false;
    for (const name of safeReaddir(rel ? path.join(envRoot, rel) : envRoot)) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (isDenied(childRel, tree)) continue;
      const p = path.join(envRoot, childRel);
      if (isLink(p)) {
        if (pointsIntoHome(p)) {
          found.push(childRel);
          any = true;
        }
        continue;
      }
      try {
        if (!fs.statSync(p).isDirectory()) continue;
        // record a directory that holds tread's links — and an empty one too,
        // which can only be a mirror an earlier configuration left behind.
        // Without the empty case a childless mirror keeps its parent non-empty
        // and the deepest-first prune can never remove either.
        if (walk(childRel, depth + 1) || safeReaddir(p).length === 0) {
          found.push(childRel);
          any = true;
        }
      } catch {}
    }
    return any;
  };
  walk("", 0);
  return found;
}

export interface SyncResult {
  added: string[];
  pruned: string[];
  /** allow-listed but absent from the real home — a typo, or a tool not installed */
  missing: string[];
  problems: ConfigProblem[];
}

/**
 * Share the allow-listed parts of the real home into the env as symlinks, and
 * remove what is no longer allowed. Re-run on every activation.
 *
 * An env isolates agent tooling, not the whole account, so the shared set has
 * to be wide enough that git, ssh and npm still work — see `defaultAllow`.
 * What makes the allow list safe is the inverse property: anything an agent
 * invents at run time (a skill's own state directory, say) was never allowed,
 * so it stays in the env without tread having to know its name.
 */
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
  const home = realHome();
  const added: string[] = [];
  const pruned: string[] = [];
  const missing: string[] = [];
  const wanted = new Set<string>();

  const { allow, userAllow, problems } = resolveConfig(envRoot);
  const tree = policyTree(allow, hardDeny());
  // only entries the user named are worth reporting as absent; tread's own
  // defaults list tools you may simply not have installed
  const asked = new Set(userAllow);

  if (!fs.existsSync(home)) return { added, pruned, missing, problems };

  const walk = (rel: string, node: Node | undefined, allowed: boolean): void => {
    if (node?.deny) return; // the env owns this path outright
    // a path only reachable because something below it is *denied* has nothing
    // to share: descending would mkdir a chain of empty mirror directories
    if (!allowed && !node?.allowBelow) return;
    const src = path.join(home, rel);
    if (!realExists(src)) {
      if (node?.allow && asked.has(rel)) missing.push(rel);
      return;
    }
    const link = path.join(envRoot, rel);

    if (allowed && !node?.denyBelow) {
      wanted.add(rel);
      if (dryRun ? wouldLink(src, link) : linkInto(src, link)) added.push(rel);
      return;
    }

    // something below must not be shared, so mirror this level instead of
    // linking it — otherwise the link would drag the denied child along
    wanted.add(rel);
    if (!dryRun) {
      if (isLink(link)) fs.rmSync(link, { force: true });
      fs.mkdirSync(link, { recursive: true });
    }

    if (allowed) {
      // inside an allowed subtree everything is shared except the denied parts
      for (const name of safeReaddir(src)) {
        walk(`${rel}/${name}`, node?.children.get(name), true);
      }
    } else {
      // only a descendant is allowed: descend to it, do not open this level up
      for (const [name, child] of node!.children) {
        walk(rel ? `${rel}/${name}` : name, child, child.allow);
      }
    }
  };

  for (const [name, child] of tree.children) walk(name, child, child.allow);

  // drop whatever the previous configuration left behind, deepest first so a
  // mirror directory is empty by the time we try to remove it
  const previous = readManifest(envRoot) ?? discoverExisting(envRoot, tree);
  const stale = previous
    .filter((p) => !wanted.has(p))
    .sort((a, b) => b.split("/").length - a.split("/").length);
  for (const rel of stale) {
    const p = path.join(envRoot, rel);
    try {
      if (isLink(p)) {
        // only ever unlink what points back at the real home
        if (pointsIntoHome(p)) {
          if (!dryRun) fs.rmSync(p, { force: true });
          pruned.push(rel);
        }
      } else if (fs.statSync(p).isDirectory()) {
        // rmdir, never rm -r: an agent may have put its own files here
        if (dryRun) {
          if (safeReaddir(p).length === 0) pruned.push(rel);
        } else {
          fs.rmdirSync(p);
          pruned.push(rel);
        }
      }
    } catch {}
  }

  if (!dryRun) writeManifest(envRoot, [...wanted].sort());
  return { added, pruned, missing, problems };
}

/**
 * Seed a usable kimi config from the real one. kimi keeps its provider and
 * model settings in config.toml, so without this a fresh env cannot start
 * even though its credentials are shared. Hooks are deliberately dropped —
 * those are tooling, and tooling is what the env is meant to isolate.
 */
function seedKimiConfig(envRoot: string): void {
  const target = path.join(agentDir(envRoot, "kimi"), "config.toml");
  if (fs.existsSync(target)) return;
  let source: string;
  try {
    source = fs.readFileSync(path.join(realHome(), ".kimi-code", "config.toml"), "utf8");
  } catch {
    return;
  }
  const kept: string[] = [];
  let skipping = false;
  for (const line of source.split("\n")) {
    if (line.trim() === "[[hooks]]") {
      skipping = true;
      continue;
    }
    if (skipping && line.startsWith("[")) skipping = false;
    if (!skipping) kept.push(line);
  }
  fs.writeFileSync(target, kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
}

/**
 * Mark onboarding as done, so a shared login is actually usable.
 *
 * Sharing the keychain item is not enough on its own. claude runs its
 * first-run wizard whenever `hasCompletedOnboarding` is not true, and that
 * wizard asks which login method you want *unconditionally* — it never looks
 * at the keychain. So a fresh environment that already resolves a valid token
 * would still open an OAuth flow, which is the exact thing sharing the
 * credential was meant to prevent. Only interactive runs hit this; `claude -p`
 * skips the wizard, which is what made it easy to miss.
 *
 * Anthropic's own plugin-eval fixture seeds this same key for the same reason,
 * so it is the supported way to say "not a first run".
 *
 * Adds the key and nothing else. This file is claude's own state — after one
 * run it holds the account, the machine id and every counter claude keeps —
 * so an unparseable one is left alone rather than replaced: claude repairs it
 * from its own cache, and a fresh object here would throw that away.
 */
function seedClaudeOnboarded(envRoot: string): void {
  const file = path.join(agentDir(envRoot, "claude"), ".claude.json");
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      doc = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (doc.hasCompletedOnboarding === true) return;
  }
  doc.hasCompletedOnboarding = true;
  writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Render `login.isolate` into the marker files the shims read.
 *
 * Rendered on every activation, both directions: config is the source of
 * truth, so an agent dropped from the list has to lose its marker too, or the
 * environment would go on demanding its own login with nothing left saying so.
 */
function syncLoginMarkers(envRoot: string): void {
  const isolated = new Set(resolveConfig(envRoot).isolateLogin);
  for (const a of AGENTS) {
    if (Object.keys(AGENT_SPECS[a].loginVars("X", false)).length === 0) continue;
    const marker = isolateLoginFile(envRoot, a);
    if (isolated.has(a)) {
      if (!fs.existsSync(marker)) {
        writeFileAtomic(
          marker,
          `# ${a} keeps its own login in this environment — set by login.isolate\n`,
        );
      }
    } else {
      fs.rmSync(marker, { force: true });
    }
  }
}

/** Create every agent's config dir plus the links a hijacked HOME needs. Idempotent. */
export function ensureSkeleton(envRoot: string): SyncResult {
  // the whole body writes, not just the sync at the end: two shells activating
  // the same environment would otherwise interleave their seeding and their
  // skill install. `syncHomeLinks` below asks for the same lock and is let
  // through re-entrantly rather than deadlocking against this one.
  return withLock(syncLockFile(envRoot), path.basename(envRoot), () => {
    for (const a of AGENTS) fs.mkdirSync(agentDir(envRoot, a), { recursive: true });
    fs.mkdirSync(skillsDir(envRoot, "kimi"), { recursive: true });
    // tread's own per-env corner: config plus the sync manifest. Hard-denied,
    // so the sync below can never link over the file that configures it.
    fs.mkdirSync(path.join(envRoot, ".tread"), { recursive: true });

    // kimi keeps credentials on disk, so a fresh env would demand a new login.
    // Link them back to the real home. claude and cursor use the keychain,
    // which `Library/Keychains` shares — though claude needs one more variable
    // on top of that, which is what `syncLoginMarkers` below governs.
    for (const n of ["credentials", "oauth"]) {
      const link = path.join(agentDir(envRoot, "kimi"), n);
      if (fs.existsSync(link) || isLink(link)) continue;
      fs.symlinkSync(path.join(realHome(), ".kimi-code", n), link);
    }
    seedKimiConfig(envRoot);
    seedClaudeOnboarded(envRoot);
    syncLoginMarkers(envRoot);
    // an agent in here has had its HOME moved out from under it; ship the
    // explanation next to the agent rather than hoping the user pastes it in
    installTreadSkill(envRoot);
    return syncHomeLinks(envRoot);
  });
}

export function createEnv(name: string): string {
  const dir = envDir(name);
  if (fs.existsSync(dir)) {
    throw new Error(
      `"${name}" already exists\n\n  ${dir}\n  tread use ${name}   to activate it`,
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  ensureSkeleton(dir);
  return dir;
}

/** Environment names. Dot-prefixed entries are cp's staging dirs, never envs. */
export function listEnvs(): string[] {
  const base = envsDir();
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export function requireEnv(name: string): string {
  const dir = envDir(name);
  if (!fs.existsSync(dir)) {
    const hint = suggest(name);
    throw new Error(
      `no environment named "${name}"\n\n` +
        (hint ? `  did you mean "${hint}"?\n` : "") +
        `  tread ls   to see all`,
    );
  }
  return dir;
}

export function resolveEnv(name?: string): string {
  if (name) return requireEnv(name);
  const active = process.env.TREAD_ENV;
  if (active) return requireEnv(active);
  throw new Error(
    "no environment active\n\n" +
      "  tread ls           list environments\n" +
      "  tread use <name>   activate one",
  );
}

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

/** Closest existing name within edit distance 2, else null. */
function suggest(name: string): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const e of listEnvs()) {
    const d = distance(name, e);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
