export const AGENTS = ["claude", "cursor", "kimi"] as const;
export type Agent = (typeof AGENTS)[number];

export interface AgentSpec {
  /** executable name on PATH */
  bin: string;
  /** other names the same agent is invoked by; each gets a shim too */
  aliases: string[];
  /** config directory, relative to the env root */
  dir: string;
  /** isolation variables, given the absolute config dir */
  envVars(absDir: string): Record<string, string>;
  /**
   * Whether the agent must be launched with HOME pointed at the env root.
   *
   * Measured, not assumed. cursor resolves mcp.json and hooks.json through a
   * hardcoded `join(homedir(), ".cursor", …)` and ignores CURSOR_CONFIG_DIR
   * for them; kimi discovers user skills under `~/.agents/skills`. Both leak
   * the real home's tooling unless HOME moves. claude keeps everything under
   * CLAUDE_CONFIG_DIR, so it needs no HOME rewrite — and gets none, to keep
   * the blast radius as small as the evidence allows.
   */
  needsHome: boolean;
  /**
   * Extra home-relative paths that must not be shared with the real home.
   * The agent's own `dir` is always isolated; this covers state the agent
   * keeps somewhere else. Paths may be nested — everything above them is
   * still shared.
   */
  isolate(platform: NodeJS.Platform): string[];
}

export const AGENT_SPECS: Record<Agent, AgentSpec> = {
  claude: {
    bin: "claude",
    aliases: [],
    dir: ".claude",
    envVars: (d) => ({ CLAUDE_CONFIG_DIR: d }),
    needsHome: false,
    isolate: () => [],
  },
  cursor: {
    bin: "cursor-agent",
    aliases: ["agent"],
    dir: ".cursor",
    envVars: (d) => ({ CURSOR_CONFIG_DIR: d, CURSOR_DATA_DIR: d }),
    needsHome: true,
    // cursor-agent also reads the desktop app's state DB, which caches the
    // skill and plugin index. Sharing it leaks every skill you ever had;
    // isolating the whole app dir would cost the login, so isolate just this.
    isolate: (p) =>
      p === "darwin"
        ? ["Library/Application Support/Cursor/User/globalStorage"]
        : p === "win32"
          ? ["AppData/Roaming/Cursor/User/globalStorage"]
          : [".config/cursor/User/globalStorage"],
  },
  kimi: {
    bin: "kimi",
    aliases: [],
    dir: ".kimi-code",
    envVars: (d) => ({ KIMI_CODE_HOME: d }),
    needsHome: true,
    isolate: () => [],
  },
};

/** Every executable name tread shims, mapped back to its agent. */
export function shimNames(): { name: string; agent: Agent }[] {
  const out: { name: string; agent: Agent }[] = [];
  for (const a of AGENTS) {
    out.push({ name: AGENT_SPECS[a].bin, agent: a });
    for (const alias of AGENT_SPECS[a].aliases) out.push({ name: alias, agent: a });
  }
  return out;
}

export function isAgent(s: string): s is Agent {
  return (AGENTS as readonly string[]).includes(s);
}
