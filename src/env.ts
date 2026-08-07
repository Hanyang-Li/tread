import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, AGENT_SPECS } from "./agents.ts";
import { agentDir, envDir, envsDir, skillsDir, stateFile } from "./paths.ts";

/** Entries tread itself writes into an agent dir when creating the skeleton. */
export const SKELETON_ENTRIES = new Set(["config.toml", "credentials", "oauth"]);

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * What an environment does NOT inherit from the real home.
 *
 * An env exists to isolate agent tooling, not to be a fresh user account: an
 * agent running with HOME moved still shells out to git, gh, npm, ssh, rustup
 * and whatever else you have. So the rule is inverted — share everything by
 * default, deny only what must stay separate. A whitelist would silently miss
 * every tool added later.
 *
 * Derived from the agent table, so registering an agent isolates it too.
 */
export function isolatedPaths(platform: NodeJS.Platform = process.platform): string[] {
  const paths = [
    ".agents", // shared skill root; kimi discovers user skills here
    ".local/state", // tread's own state lives here — a link would nest the env in itself
  ];
  for (const a of AGENTS) {
    paths.push(AGENT_SPECS[a].dir, ...AGENT_SPECS[a].isolate(platform));
  }
  return paths;
}

interface DenyNode {
  deny: boolean;
  children: Map<string, DenyNode>;
}

function denyTree(paths: string[]): DenyNode {
  const root: DenyNode = { deny: false, children: new Map() };
  for (const p of paths) {
    let node = root;
    for (const part of p.split("/")) {
      let next = node.children.get(part);
      if (!next) {
        next = { deny: false, children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    }
    node.deny = true;
  }
  return root;
}

/** True when `link` is a symlink tread created into the real home. */
function pointsIntoHome(link: string): boolean {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    return fs.readlinkSync(link).startsWith(os.homedir() + path.sep);
  } catch {
    return false;
  }
}

function linkInto(target: string, link: string): boolean {
  // a real file or directory in the env always wins
  if (fs.existsSync(link) && !isLink(link)) return false;
  if (isLink(link)) {
    if (fs.readlinkSync(link) === target) return false;
    fs.rmSync(link, { force: true });
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
  return true;
}

/**
 * Mirror the real home into the env as symlinks, minus the isolated names.
 * Re-run on every activation so anything added to the home later shows up.
 * Returns the entries added and the dead links pruned.
 */
export function syncHomeLinks(envRoot: string): { added: string[]; pruned: string[] } {
  const home = os.homedir();
  const added: string[] = [];
  const pruned: string[] = [];
  const walked: string[] = [];

  const walk = (rel: string, node: DenyNode): void => {
    const src = rel ? path.join(home, rel) : home;
    const dst = rel ? path.join(envRoot, rel) : envRoot;
    walked.push(dst);
    for (const name of safeReaddir(src)) {
      const child = node.children.get(name);
      const childRel = rel ? `${rel}/${name}` : name;
      const link = path.join(dst, name);

      if (child?.deny) {
        // fully isolated: the env owns this path, tread never links it
        continue;
      }
      if (child) {
        // an isolated path lives below here, so mirror this level instead of
        // linking it — otherwise the link would drag the denied child along
        if (isLink(link)) fs.rmSync(link, { force: true });
        fs.mkdirSync(link, { recursive: true });
        walk(childRel, child);
        continue;
      }
      if (linkInto(path.join(src, name), link)) added.push(childRel);
    }
  };

  if (!fs.existsSync(home)) return { added, pruned };
  walk("", denyTree(isolatedPaths()));

  // drop links whose target disappeared from the real home
  for (const dir of walked) {
    for (const name of safeReaddir(dir)) {
      const link = path.join(dir, name);
      if (!pointsIntoHome(link)) continue;
      if (fs.existsSync(link)) continue;
      fs.rmSync(link, { force: true });
      pruned.push(path.relative(envRoot, link));
    }
  }

  return { added, pruned };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
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
    source = fs.readFileSync(path.join(os.homedir(), ".kimi-code", "config.toml"), "utf8");
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

/** Create every agent's config dir plus the links a hijacked HOME needs. Idempotent. */
export function ensureSkeleton(envRoot: string): void {
  for (const a of AGENTS) fs.mkdirSync(agentDir(envRoot, a), { recursive: true });
  fs.mkdirSync(skillsDir(envRoot, "kimi"), { recursive: true });

  // kimi keeps credentials on disk, so a fresh env would demand a new login.
  // Link them back to the real home. claude and cursor use the keychain.
  for (const n of ["credentials", "oauth"]) {
    const link = path.join(agentDir(envRoot, "kimi"), n);
    if (fs.existsSync(link) || isLink(link)) continue;
    fs.symlinkSync(path.join(os.homedir(), ".kimi-code", n), link);
  }
  seedKimiConfig(envRoot);
  syncHomeLinks(envRoot);
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

export function listEnvs(): string[] {
  const base = envsDir();
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
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
  fs.rmSync(requireEnv(name), { recursive: true, force: true });
  const s = readState();
  delete s.lastUsed[name];
  writeState(s);
}

interface State {
  lastUsed: Record<string, string>;
}

function readState(): State {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return { lastUsed: j?.lastUsed ?? {} };
  } catch {
    return { lastUsed: {} };
  }
}

function writeState(s: State): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2) + "\n");
}

export function lastUsed(): Record<string, string> {
  return readState().lastUsed;
}

export function touchLastUsed(name: string): void {
  const s = readState();
  s.lastUsed[name] = new Date().toISOString();
  writeState(s);
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
