import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AGENTS, type Agent } from "./agents.ts";
import { agentDir, loginIsolated, realHome } from "./paths.ts";

/**
 * The account name claude stores its keychain item under.
 *
 * claude falls back to a fixed string when $USER is missing or has an
 * unexpected shape; the fallback is reproduced because an environment where it
 * applies is exactly one where a mismatch would be confusing to debug.
 */
function keychainAccount(): string {
  let user: string;
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {
    return "claude-code-user";
  }
  return /^[A-Za-z0-9._@-]+$/.test(user) ? user : "claude-code-user";
}

/**
 * The keychain service name claude resolves its stored login under.
 *
 * A reimplementation of claude's own construction (read off v2.1.227):
 * `Claude Code-credentials`, with the first 8 hex of the config dir's sha256
 * appended — unless CLAUDE_SECURESTORAGE_CONFIG_DIR is defined and empty, in
 * which case the suffix is dropped and the item is the one the real home uses.
 * Passing null asks for that shared name.
 *
 * Reimplemented because claude offers no way to ask, which makes this the part
 * of tread most likely to be silently invalidated by a claude release. That is
 * the whole reason `doctor` probes for the item rather than trusting the name
 * it just computed: the probe failing is the signal that this went stale.
 */
export function claudeServiceName(configDir: string | null): string {
  const base = "Claude Code-credentials";
  if (configDir === null) return base;
  const hash = crypto.createHash("sha256").update(configDir.normalize("NFC")).digest("hex");
  return `${base}-${hash.slice(0, 8)}`;
}

/** Whether a keychain item exists. Existence only — the value is never read. */
export function keychainItemExists(service: string): boolean | null {
  if (process.platform !== "darwin") return null;
  try {
    execFileSync("security", ["find-generic-password", "-a", keychainAccount(), "-s", service], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface LoginRow {
  agent: Agent;
  /** How this agent's login reaches an environment at all. */
  mechanism: string;
  /** True/false when tread could check, null when there is nothing to probe. */
  present: boolean | null;
}

/**
 * How each agent shares its login with the real home, by default.
 *
 * Reported once rather than per environment because sharing *is* the default
 * and the mechanism is a property of the agent, not of any one environment.
 * The environments that opted out are the exception, and `loginIssues` reports
 * those where they belong.
 */
export function sharedLogin(): LoginRow[] {
  return AGENTS.map((agent): LoginRow => {
    if (agent === "claude") {
      const service = claudeServiceName(null);
      return {
        agent,
        mechanism: `keychain · ${service}`,
        present: keychainItemExists(service),
      };
    }
    if (agent === "kimi") {
      const p = path.join(realHome(), ".kimi-code", "credentials");
      return { agent, mechanism: `${tilde(p)} · symlinked in`, present: fs.existsSync(p) };
    }
    // cursor's service name carries nothing environment-specific, so sharing
    // Library/Keychains is the whole mechanism and there is no name to compute
    return { agent, mechanism: "keychain · fixed service name", present: null };
  });
}

function tilde(p: string): string {
  const home = realHome();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * What is wrong with one environment's login, if anything.
 *
 * Only the opted-out environments can have a problem of their own: a sharing
 * one resolves the same item as every other, which `sharedLogin` already
 * covers, and repeating it per environment would turn one missing login into
 * a wall of identical complaints.
 */
export function loginIssues(envRoot: string): string[] {
  const out: string[] = [];
  for (const agent of AGENTS) {
    if (agent !== "claude" || !loginIsolated(envRoot, agent)) continue;
    const service = claudeServiceName(agentDir(envRoot, agent));
    if (keychainItemExists(service) === false) {
      out.push(`claude   login.isolate is set and this env has not logged in yet`);
    }
  }
  return out;
}
