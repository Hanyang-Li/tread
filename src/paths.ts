import os from "node:os";
import path from "node:path";
import { AGENT_SPECS, AGENTS, type Agent } from "./agents.ts";

export const realHome = os.homedir();

export function stateDir(): string {
  return process.env.TREAD_STATE_DIR ?? path.join(realHome, ".local/state/tread");
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
 * The variables `tread use` exports into the caller's shell.
 *
 * HOME is deliberately absent: cursor and kimi need it moved, but rewriting
 * HOME for the whole shell would break git, ssh and npm. Their shims set it
 * for the agent process alone.
 */
export function activationEnv(envRoot: string): Record<string, string> {
  const out: Record<string, string> = { TREAD_ENV_DIR: envRoot };
  for (const a of AGENTS) {
    Object.assign(out, AGENT_SPECS[a].envVars(agentDir(envRoot, a)));
  }
  return out;
}
