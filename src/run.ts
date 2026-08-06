import fs from "node:fs";
import path from "node:path";
import { layout, realHome, type Agent } from "./paths.ts";
import { requireEnv } from "./env.ts";

/** Launch an agent with its config redirected into the env directory. */
export async function runAgent(agent: Agent, name: string, agentArgs: string[]): Promise<number> {
  const dir = requireEnv(agent, name);
  const l = layout(agent, dir);
  const env: Record<string, string | undefined> = { ...process.env };
  let cmd: string;
  const args: string[] = [];

  switch (agent) {
    case "claude":
      cmd = "claude";
      env.CLAUDE_CONFIG_DIR = l.configDir;
      break;
    case "kimi":
      cmd = "kimi";
      env.KIMI_CODE_HOME = l.configDir;
      break;
    case "cursor": {
      cmd = "cursor-agent";
      // cursor-agent keeps all state under ~/.cursor — redirect HOME.
      env.HOME = dir;
      const gitconfig = path.join(realHome, ".gitconfig");
      if (fs.existsSync(gitconfig)) env.GIT_CONFIG_GLOBAL = gitconfig;
      // Load tread-managed plugins via the official --plugin-dir flag.
      if (fs.existsSync(l.pluginsDir)) {
        for (const e of fs.readdirSync(l.pluginsDir, { withFileTypes: true })) {
          if (e.isDirectory()) args.push("--plugin-dir", path.join(l.pluginsDir, e.name));
        }
      }
      break;
    }
  }

  const proc = Bun.spawn([cmd, ...args, ...agentArgs], {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}
