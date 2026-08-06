import os from "node:os";
import path from "node:path";

export const AGENTS = ["claude", "cursor", "kimi"] as const;
export type Agent = (typeof AGENTS)[number];

export const realHome = os.homedir();

/** Overridable via env for testing. */
export function stateDir(): string {
  return process.env.TREAD_STATE_DIR ?? path.join(realHome, ".local/state/tread");
}
export function shareDir(): string {
  return process.env.TREAD_SHARE_DIR ?? path.join(realHome, ".local/share/tread");
}
export function binDir(): string {
  return path.join(realHome, ".local/bin");
}

export function isAgent(s: string): s is Agent {
  return (AGENTS as readonly string[]).includes(s);
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateEnvName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid env name "${name}": use letters, digits, dot, dash, underscore`);
  }
}

export function envDir(agent: Agent, name: string): string {
  validateEnvName(name);
  return path.join(stateDir(), agent, name);
}

/** Per-agent directory layout inside an env. */
export function layout(agent: Agent, env: string) {
  switch (agent) {
    case "claude": {
      const config = path.join(env, ".claude");
      return {
        configDir: config,
        skillsDir: path.join(config, "skills"),
        pluginsDir: path.join(config, "plugins"),
        hooksFile: path.join(config, "settings.json"),
        mcpFile: path.join(config, ".claude.json"),
      };
    }
    case "cursor": {
      const config = path.join(env, ".cursor");
      return {
        configDir: config,
        // the skills CLI installs cursor skills to ~/.agents/skills, which
        // cursor-agent also discovers (its skill-path-utils include .agents/skills/)
        skillsDir: path.join(env, ".agents/skills"),
        pluginsDir: path.join(env, "plugins"),
        hooksFile: path.join(config, "hooks.json"),
        mcpFile: path.join(config, "mcp.json"),
      };
    }
    case "kimi": {
      const config = path.join(env, ".kimi-code");
      return {
        configDir: config,
        skillsDir: path.join(env, ".agents/skills"),
        pluginsDir: path.join(config, "plugins"),
        hooksFile: path.join(config, "config.toml"),
        mcpFile: path.join(config, "mcp.json"),
      };
    }
  }
}

/** The `skills` CLI (npx skills) agent flag for each tread agent. */
export function skillsAgentFlag(agent: Agent): string {
  switch (agent) {
    case "claude":
      return "claude-code";
    case "cursor":
      return "cursor";
    case "kimi":
      return "kimi-code-cli";
  }
}

export function skillsCliPath(): string {
  return path.join(shareDir(), "node_modules/skills/bin/cli.mjs");
}
