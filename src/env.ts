import fs from "node:fs";
import path from "node:path";
import { AGENTS, envDir, isAgent, layout, stateDir, validateEnvName, type Agent } from "./paths.ts";

export function createEnv(agent: Agent, name: string): string {
  const dir = envDir(agent, name);
  if (fs.existsSync(dir)) throw new Error(`env already exists: ${dir}`);
  const l = layout(agent, dir);
  fs.mkdirSync(l.skillsDir, { recursive: true });
  fs.mkdirSync(l.pluginsDir, { recursive: true });
  if (agent === "kimi") {
    // kimi does not follow ~/.agents/skills when KIMI_CODE_HOME is redirected,
    // so declare the env's skills dir explicitly.
    fs.writeFileSync(
      path.join(l.configDir, "config.toml"),
      `extra_skill_dirs = ["${l.skillsDir}"]\n`,
    );
  }
  return dir;
}

export function listEnvs(agent?: Agent): Record<string, string[]> {
  const agents: readonly Agent[] = agent ? [agent] : AGENTS;
  const out: Record<string, string[]> = {};
  for (const a of agents) {
    const base = path.join(stateDir(), a);
    if (!fs.existsSync(base)) {
      out[a] = [];
      continue;
    }
    out[a] = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }
  return out;
}

export function removeEnv(agent: Agent, name: string): void {
  const dir = envDir(agent, name);
  if (!fs.existsSync(dir)) throw new Error(`env not found: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function requireEnv(agent: Agent, name: string): string {
  const dir = envDir(agent, name);
  if (!fs.existsSync(dir)) throw new Error(`env not found: ${dir} (create it with: tread create ${agent} ${name})`);
  return dir;
}

export function parseAgentEnv(args: string[]): { agent: Agent; name: string } {
  const [a, n] = args;
  if (!a || !isAgent(a)) throw new Error(`expected agent (${AGENTS.join("|")}), got "${a ?? ""}"`);
  if (!n) throw new Error("expected env name");
  validateEnvName(n);
  return { agent: a, name: n };
}
