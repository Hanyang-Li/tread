import fs from "node:fs";
import path from "node:path";
import { AGENTS, AGENT_SPECS, isAgent, type Agent } from "./agents.ts";
import { realHome } from "./paths.ts";

/**
 * What an environment shares with the real home, before configuration.
 *
 * An env isolates agent tooling, not the whole user account: an agent running
 * with HOME moved still shells out to git, ssh, npm, cargo and whatever else
 * you have. Every entry here is a tool that breaks — often silently, with the
 * wrong identity or the wrong registry rather than an error — when it cannot
 * find its dotfile. Shipping the list is the point: an allow-list that each
 * user has to discover by breaking things is worse than no allow-list.
 *
 * Add to it freely. The failure mode of one entry too many is a leak you can
 * see; the failure mode of one too few is a tool misbehaving three layers down.
 */
export function defaultAllow(platform: NodeJS.Platform = process.platform): string[] {
  const paths = [
    // shells — agents spawn login and interactive shells to run commands
    ".profile", ".bashrc", ".bash_profile", ".zshenv", ".zshrc", ".inputrc",

    // git and transport credentials; without these commits get the wrong
    // author and pushes fail
    ".gitconfig", ".gitignore_global", ".git-credentials", ".ssh", ".netrc",

    // the shared config root: gh, starship, fish, nvim, direnv, atuin, gcloud…
    // too many tools to enumerate, and tread's own config is hard-denied below
    ".config",

    // caches are large but re-downloading them in every env is worse; a common
    // `remove:` candidate for anyone who disagrees
    ".cache",

    // ~/.local/state is tread's own and hard-denied, so allow the siblings
    // rather than .local wholesale — claude itself lives under .local/share
    ".local/bin", ".local/share",

    // language toolchains and their registry auth
    ".asdf", ".tool-versions",
    ".cargo", ".rustup",
    ".npm", ".npmrc", ".nvm", ".bun", ".pnpm-state", ".yarn", ".yarnrc",
    ".m2", ".gradle", ".sdkman",
    ".pyenv", ".rbenv", ".gem",
    "go",

    // cloud and infra credentials
    ".docker", ".kube", ".aws", ".azure", ".terraform.d",

    // editors an agent may shell into
    ".vim", ".vimrc",
  ];
  if (platform === "darwin") {
    // quiets the login banner and locale warning in spawned shells
    paths.push(".hushlogin", ".CFUserTextEncoding");
    // macOS resolves the login keychain through $HOME, so moving HOME takes
    // it out of the search list entirely and Security reports "a default
    // keychain could not be found" — which is every agent's stored login.
    // Measured: with HOME on the env, `security find-generic-password -s
    // "Claude Code-credentials"` finds nothing; with this one path shared it
    // finds it again. Keychains only, never Library: the rest is app state,
    // which is exactly what an environment exists to keep apart.
    paths.push("Library/Keychains");
  }
  return paths;
}

/**
 * Paths no configuration can share, whatever the user writes.
 *
 * Two kinds: tread's own surfaces, which would either nest an environment
 * inside itself or let a link overwrite the very config that decides linking;
 * and the agent directories, which must stay real directories in the env
 * because that is what isolation *is*.
 */
export function hardDeny(platform: NodeJS.Platform = process.platform): string[] {
  const paths = [
    ".local/state", // tread's state dir — a link here nests the env in itself
    ".tread", // per-env config; must survive the sync that reads it
    ".config/tread", // global config; should not be visible inside an env
    ".agents", // shared skill root; kimi discovers user skills here
  ];
  for (const a of AGENTS) {
    paths.push(AGENT_SPECS[a].dir, ...AGENT_SPECS[a].isolate(platform));
  }
  return paths;
}

export interface AllowPatch {
  extra?: string[];
  remove?: string[];
  replace?: string[];
}

export interface ConfigProblem {
  file: string;
  message: string;
}

export interface ResolvedConfig {
  /** Home-relative paths to share, hard-denied entries already stripped. */
  allow: string[];
  /**
   * Agents this environment keeps its own login for.
   *
   * Not a patch like `allow`, and not for the same reason: the allow list is
   * an evolving default worth expressing intent against, while this is a
   * closed set of three that a later layer should simply be able to answer
   * outright. An env saying `login: {isolate: []}` means shared, not
   * "inherit whatever is global".
   */
  isolateLogin: Agent[];
  /**
   * The subset the user asked for by name.
   *
   * Worth separating because absence means opposite things on the two sides:
   * tread's defaults are speculative — no `.pyenv` just means you do not use
   * pyenv — while a configured entry that is not there is a typo or a tool
   * that got uninstalled, and is worth saying out loud.
   */
  userAllow: string[];
  problems: ConfigProblem[];
  files: string[];
}

export function globalConfigFile(): string {
  return path.join(realHome(), ".config", "tread", "config.yaml");
}

export function envConfigFile(envRoot: string): string {
  return path.join(envRoot, ".tread", "config.yaml");
}

const KNOWN_ALLOW_KEYS = new Set(["extra", "remove", "replace"]);

/**
 * Normalise one configured path. Returns null and records a problem when the
 * entry could escape the home or name something other than a relative path.
 */
function cleanEntry(
  raw: unknown,
  file: string,
  problems: ConfigProblem[],
): string | null {
  if (typeof raw !== "string") {
    problems.push({ file, message: `not a string: ${JSON.stringify(raw)}` });
    return null;
  }
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) {
    problems.push({ file, message: "empty path" });
    return null;
  }
  if (path.isAbsolute(v) || v.startsWith("~")) {
    problems.push({ file, message: `must be relative to home: "${raw}"` });
    return null;
  }
  const parts = v.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === "..")) {
    problems.push({ file, message: `"." and ".." are not allowed: "${raw}"` });
    return null;
  }
  return parts.join("/");
}

/** One config file's contribution: an allow patch, plus a login answer if it gave one. */
interface Layer {
  allow: AllowPatch;
  /** Absent means the file said nothing; `[]` means it said "share everything". */
  isolateLogin?: Agent[];
}

/** Parse `login: {isolate: [...]}`, or record why it was ignored. */
function readLogin(
  raw: unknown,
  file: string,
  problems: ConfigProblem[],
): Agent[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push({ file, message: "login must be a mapping with an isolate list" });
    return undefined;
  }
  const out: Agent[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== "isolate") {
      problems.push({ file, message: `unknown key "login.${k}"` });
      continue;
    }
    if (!Array.isArray(v)) {
      problems.push({ file, message: "login.isolate must be a list" });
      continue;
    }
    for (const item of v) {
      if (typeof item !== "string" || !isAgent(item)) {
        problems.push({
          file,
          message: `login.isolate: not an agent: ${JSON.stringify(item)}`,
        });
        continue;
      }
      // naming an agent that shares its login by other means is a
      // misunderstanding worth surfacing, not a silent no-op
      if (Object.keys(AGENT_SPECS[item].loginVars("X", false)).length === 0) {
        problems.push({
          file,
          message: `login.isolate: "${item}" has no per-environment login to isolate`,
        });
        continue;
      }
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

function readLayer(file: string, problems: ConfigProblem[]): Layer | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // absent is the normal case, not a problem
  }
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    problems.push({ file, message: `not valid YAML: ${e instanceof Error ? e.message : e}` });
    return null;
  }
  if (doc == null) return null; // empty file
  if (typeof doc !== "object" || Array.isArray(doc)) {
    problems.push({ file, message: "top level must be a mapping" });
    return null;
  }
  const root = doc as Record<string, unknown>;
  for (const k of Object.keys(root)) {
    if (k !== "allow" && k !== "login") {
      problems.push({ file, message: `unknown key "${k}"` });
    }
  }
  const isolateLogin = readLogin(root.login, file, problems);
  const allow = root.allow;
  if (allow === undefined) return { allow: {}, isolateLogin };
  if (typeof allow !== "object" || allow === null || Array.isArray(allow)) {
    problems.push({
      file,
      message: "allow must be a mapping of extra / remove / replace",
    });
    return null;
  }
  const patch: AllowPatch = {};
  for (const [k, v] of Object.entries(allow as Record<string, unknown>)) {
    if (!KNOWN_ALLOW_KEYS.has(k)) {
      problems.push({ file, message: `unknown key "allow.${k}"` });
      continue;
    }
    if (!Array.isArray(v)) {
      problems.push({ file, message: `allow.${k} must be a list` });
      continue;
    }
    const cleaned: string[] = [];
    for (const item of v) {
      const c = cleanEntry(item, file, problems);
      if (c) cleaned.push(c);
    }
    patch[k as keyof AllowPatch] = cleaned;
  }
  return { allow: patch, isolateLogin };
}

/** Apply one layer. `replace` discards everything below it; otherwise extra then remove. */
function applyLayer(base: Set<string>, patch: AllowPatch): Set<string> {
  if (patch.replace) return new Set(patch.replace);
  const next = new Set(base);
  for (const p of patch.extra ?? []) next.add(p);
  // remove wins inside a layer; a later layer's extra can still add it back
  for (const p of patch.remove ?? []) next.delete(p);
  return next;
}

/**
 * Resolve the three layers into one allow list.
 *
 * Layers are patches rather than full lists on purpose: tread's default set
 * grows over time, and only an expression of intent ("I do not want .cache")
 * can be re-applied against a new default. A full list records the outcome,
 * which silently freezes at whatever the default was the day it was written.
 */
export function resolveConfig(
  envRoot: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedConfig {
  const problems: ConfigProblem[] = [];
  const files: string[] = [];
  const asked = new Set<string>();
  let set = new Set(defaultAllow(platform));

  let isolateLogin: Agent[] = [];

  for (const file of [globalConfigFile(), envConfigFile(envRoot)]) {
    const layer = readLayer(file, problems);
    if (layer === null) continue;
    files.push(file);
    const patch = layer.allow;
    for (const p of patch.replace ?? patch.extra ?? []) asked.add(p);
    for (const p of patch.remove ?? []) asked.delete(p);
    set = applyLayer(set, patch);
    // last layer to express an opinion wins outright — see ResolvedConfig
    if (layer.isolateLogin !== undefined) isolateLogin = layer.isolateLogin;
  }

  // hard deny always wins, and saying so out loud beats failing silently
  const deny = new Set(hardDeny(platform));
  for (const p of [...set]) {
    if (!deny.has(p)) continue;
    set.delete(p);
    asked.delete(p);
    if (files.length > 0) {
      problems.push({
        file: files.at(-1)!,
        message: `"${p}" is always isolated and cannot be shared`,
      });
    }
  }

  return {
    allow: [...set].sort(),
    isolateLogin,
    userAllow: [...asked].filter((p) => set.has(p)).sort(),
    problems,
    files,
  };
}
