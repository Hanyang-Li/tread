import os from "node:os";
import path from "node:path";
import { AGENT_SPECS, AGENTS, type Agent } from "./agents.ts";

/**
 * The user's actual home, even when tread is running inside an environment.
 *
 * Agent shims replace HOME with the env root, so `os.homedir()` — which reads
 * $HOME, as does `os.userInfo()` under bun — answers with the environment when
 * an agent shells out to `tread`. That made every path tread derives from home
 * point into the env: `tread ls` inside claude reported no environments at all.
 * The shim stashes the real value in TREAD_HOME just before overwriting HOME.
 */
export function realHome(): string {
  return process.env.TREAD_HOME || os.homedir();
}

export function stateDir(): string {
  return process.env.TREAD_STATE_DIR ?? path.join(realHome(), ".local/state/tread");
}

export function envsDir(): string {
  return path.join(stateDir(), "envs");
}

export function stateFile(): string {
  return path.join(stateDir(), "state.json");
}

/** Shim directory, prepended to PATH while an environment is active. */
export function shimsDir(): string {
  return path.join(stateDir(), "shims");
}

/**
 * Where tread writes files other tools read — the zsh completion, for now.
 *
 * The same shape as stateDir(), for the same two reasons: realHome() so that
 * an agent shelling out to tread does not write into the environment its shim
 * moved HOME to, and an override so tests can land somewhere temporary.
 */
export function dataDir(): string {
  return process.env.TREAD_DATA_DIR ?? path.join(realHome(), ".local/share/tread");
}

/** The zsh completion function. zsh autoloads it by this exact file name. */
export function completionFile(): string {
  return path.join(dataDir(), "_tread");
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateEnvName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid name "${name}"\n\n  use letters, digits, dot, dash, underscore`,
    );
  }
}

export function envDir(name: string): string {
  validateEnvName(name);
  return path.join(envsDir(), name);
}

export function agentDir(envRoot: string, a: Agent): string {
  return path.join(envRoot, AGENT_SPECS[a].dir);
}

/**
 * Where global skills live for an agent inside an environment.
 * claude and cursor look under their own config dir; kimi discovers
 * `~/.agents/skills`, which resolves into the env because its shim moves HOME.
 */
export function skillsDir(envRoot: string, a: Agent): string {
  return a === "kimi"
    ? path.join(envRoot, ".agents/skills")
    : path.join(agentDir(envRoot, a), "skills");
}

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

/**
 * The variables `tread use` exports into the caller's shell.
 *
 * HOME is deliberately absent: cursor and kimi need it moved, but rewriting
 * HOME for the whole shell would break git, ssh and npm. Their shims set it
 * for the agent process alone.
 */
export function activationEnv(envRoot: string): Record<string, string> {
  // carried so tread still knows the real home once a shim moves HOME
  const out: Record<string, string> = { TREAD_ENV_DIR: envRoot, TREAD_HOME: realHome() };
  for (const a of AGENTS) {
    Object.assign(out, AGENT_SPECS[a].envVars(agentDir(envRoot, a)));
  }
  return out;
}
