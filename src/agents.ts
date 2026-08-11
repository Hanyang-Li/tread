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
   * Variables deciding whether the agent's stored login is shared with the
   * real home, given the absolute config dir and whether this environment
   * opted out.
   *
   * Only claude needs any. Sharing `Library/Keychains` is already enough for
   * cursor, whose keychain service name is a constant, and `ensureSkeleton`
   * symlinks kimi's credential files back — so both share their login across
   * environments without tread doing anything else. claude is the exception:
   * it hashes CLAUDE_CONFIG_DIR into its own service name, so every
   * environment resolves a different keychain item and has to log in again.
   *
   * The empty string is load-bearing. claude skips the hash only when
   * CLAUDE_SECURESTORAGE_CONFIG_DIR is *defined and empty*, and it carries a
   * special case through to subprocesses so that empty value survives — so
   * unsetting the variable and setting it to "" mean opposite things, and
   * nothing here may treat a falsy value as absent.
   */
  loginVars(absDir: string, isolated: boolean): Record<string, string>;
  /**
   * Whether the agent must be launched with HOME pointed at the env root.
   *
   * True for all three, and for one shared reason: an agent's own config
   * variable only governs the paths the agent itself resolves, while every
   * one of them runs third-party code that goes through homedir() instead.
   * cursor reads mcp.json and hooks.json from a hardcoded
   * `join(homedir(), ".cursor", …)`; kimi discovers user skills under
   * `~/.agents/skills`; claude does honour CLAUDE_CONFIG_DIR throughout, but
   * a skill installing a hook computes `join(homedir(), ".claude",
   * "settings.json")` and writes to the real home no matter what
   * CLAUDE_CONFIG_DIR says. HOME is the only lever that reaches code tread
   * does not control.
   */
  needsHome: boolean;
  /**
   * Extra home-relative paths that must not be shared with the real home.
   * The agent's own `dir` is always isolated; this covers state the agent
   * keeps somewhere else. Paths may be nested — everything above them is
   * still shared.
   */
  isolate(platform: NodeJS.Platform): string[];
  /**
   * Agent-dir-relative paths a copy of the environment should not carry over:
   * session transcripts, history, logs, telemetry, caches, per-install ids.
   *
   * Matched as exact paths, never by name. `.claude/cache` is throwaway while
   * `.claude/plugins/cache` holds the plugin bodies — a third of the bytes in
   * an environment — and dropping it would still leave a status table claiming
   * the plugins are installed, since that count comes from a manifest.
   */
  volatile: string[];
}

export const AGENT_SPECS: Record<Agent, AgentSpec> = {
  claude: {
    bin: "claude",
    aliases: [],
    dir: ".claude",
    // CLAUDE_CONFIG_DIR stays even though HOME now covers it: `tread use`
    // exports it into the shell, so a claude started by absolute path —
    // bypassing the shim entirely — is still redirected.
    envVars: (d) => ({ CLAUDE_CONFIG_DIR: d }),
    // isolated resolves to the config dir rather than leaving the variable
    // unset: both give this environment its own keychain item, but a value
    // survives switching from a sharing environment to this one, where an
    // absent variable would leave the previous "" in the shell.
    loginVars: (d, isolated) => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: isolated ? d : "" }),
    needsHome: true,
    isolate: () => [],
    volatile: [
      "projects", "sessions", "session-env", "shell-snapshots",
      "history.jsonl", "telemetry", "cache", "backups", ".last-cleanup",
    ],
  },
  cursor: {
    bin: "cursor-agent",
    aliases: ["agent"],
    dir: ".cursor",
    envVars: (d) => ({ CURSOR_CONFIG_DIR: d, CURSOR_DATA_DIR: d }),
    // nothing to set: cursor-agent stores its login in the keychain under a
    // fixed service name, so sharing Library/Keychains already shares it
    loginVars: () => ({}),
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
    volatile: ["chats", "projects", "ai-tracking", "statsig-cache.json"],
  },
  kimi: {
    bin: "kimi",
    aliases: [],
    dir: ".kimi-code",
    envVars: (d) => ({ KIMI_CODE_HOME: d }),
    // nothing to set: kimi keeps credentials in files, which `ensureSkeleton`
    // symlinks back to the real home
    loginVars: () => ({}),
    needsHome: true,
    isolate: () => [],
    volatile: [
      "sessions", "logs", "search-index", "user-history",
      "session_index.jsonl", "telemetry", "device_id",
    ],
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
