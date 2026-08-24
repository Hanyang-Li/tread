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
   * How to stop the agent updating itself while an environment is active.
   *
   * Every one of them installs its update relative to something a shim has
   * moved, so an update from in here lands in the wrong place and then
   * outlives the environment. claude and cursor resolve their install root
   * through `homedir()` and reach the real home through the shared `.local`
   * link, so what they leave behind is a launcher in the user's own home whose
   * target names an environment — `stray.ts` is about repairing exactly that.
   * kimi's is worse, because its install root is the *isolated* `.kimi-code`:
   * the update writes a second 180MB binary inside one environment, the
   * installer prepends that absolute path to the shared `.zshrc`, and from
   * then on every other environment — and plain `kimi` outside tread — starts
   * resolving to it.
   *
   * `vars` is the lever wherever the agent has one. `args` is for cursor,
   * which has none: its only switch is a hidden `--disable-auto-update` on the
   * root command, so the shim inserts it. Either way this applies only while
   * TREAD_ENV_DIR is set — updating is still the user's to do, it just has to
   * happen outside an environment.
   */
  noUpdate: { vars: Record<string, string>; args: string[] };
  /**
   * Where an update run inside an environment leaves the binary, relative to
   * the env root — or null when the agent's install root is a shared path, so
   * the copy lands in the real home and the damage is a stray link instead.
   *
   * Only kimi has one: `KIMI_CODE_HOME` is `<env>/.kimi-code`, which is
   * isolated by definition, so nothing about the write reaches the real home
   * and there is no link for `stray.ts` to find. What there is instead is a
   * whole binary inside the environment, which `doctor` reports and `--fix`
   * removes so the environment falls back to the shared install.
   */
  inEnvBin: string | null;
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
    noUpdate: { vars: { DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" }, args: [] },
    inEnvBin: null,
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
    // no environment variable exists; the flag is hidden but it is the same
    // one the background check reads, and `cursor-agent update` still updates
    noUpdate: { vars: {}, args: ["--disable-auto-update"] },
    inEnvBin: null,
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
    // both names, because kimi still honours the kimi-cli one it inherited and
    // an older binary in an environment may only know that one
    noUpdate: {
      vars: { KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CLI_NO_AUTO_UPDATE: "1" },
      args: [],
    },
    inEnvBin: ".kimi-code/bin/kimi",
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
