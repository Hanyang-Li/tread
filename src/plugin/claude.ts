import { layout } from "../paths.ts";
import { requireEnv } from "../env.ts";
import { runPassthrough } from "./market.ts";

function claudeEnv(envName: string): Record<string, string | undefined> {
  const dir = requireEnv("claude", envName);
  return { ...process.env, CLAUDE_CONFIG_DIR: layout("claude", dir).configDir };
}

/**
 * Claude Code has a fully scriptable plugin CLI; tread just injects
 * CLAUDE_CONFIG_DIR so all state lands in the environment.
 */
export async function claudePlugin(action: string, envName: string, args: string[]): Promise<number> {
  const env = claudeEnv(envName);
  switch (action) {
    case "add": {
      const [source, ...rest] = args;
      if (!source) throw new Error("usage: tread plugin add claude <env> <marketplace-source> [name@marketplace]");
      let code = await runPassthrough(["claude", "plugin", "marketplace", "add", source], { env });
      if (code !== 0) return code;
      const plugin = rest[0];
      if (plugin) {
        code = await runPassthrough(["claude", "plugin", "install", plugin], { env });
      }
      return code;
    }
    case "ls":
      return await runPassthrough(["claude", "plugin", "list"], { env });
    case "rm": {
      const [name] = args;
      if (!name) throw new Error("usage: tread plugin rm claude <env> <name@marketplace>");
      return await runPassthrough(["claude", "plugin", "uninstall", name, "-y"], { env });
    }
    case "update": {
      const [name] = args;
      const cmd = name
        ? ["claude", "plugin", "update", name]
        : ["claude", "plugin", "marketplace", "update"];
      return await runPassthrough(cmd, { env });
    }
    default:
      throw new Error(`unknown plugin action "${action}" (add|ls|rm|update)`);
  }
}
