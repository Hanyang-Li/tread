export const AGENTS = ["claude", "cursor", "kimi"] as const;
export type Agent = (typeof AGENTS)[number];

export interface AgentSpec {
  /** executable name on PATH */
  bin: string;
  /** config directory, relative to the env root */
  dir: string;
  /** isolation variables, given the absolute config dir */
  envVars(absDir: string): Record<string, string>;
}

export const AGENT_SPECS: Record<Agent, AgentSpec> = {
  claude: {
    bin: "claude",
    dir: ".claude",
    envVars: (d) => ({ CLAUDE_CONFIG_DIR: d }),
  },
  cursor: {
    bin: "cursor-agent",
    dir: ".cursor",
    // cursor resolves config and data separately; point both at one directory,
    // mirroring the real ~/.cursor where they coincide.
    envVars: (d) => ({ CURSOR_CONFIG_DIR: d, CURSOR_DATA_DIR: d }),
  },
  kimi: {
    bin: "kimi",
    dir: ".kimi-code",
    envVars: (d) => ({ KIMI_CODE_HOME: d }),
  },
};

export function isAgent(s: string): s is Agent {
  return (AGENTS as readonly string[]).includes(s);
}
