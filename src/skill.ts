import fs from "node:fs";
import { skillsAgentFlag, skillsCliPath, type Agent } from "./paths.ts";
import { requireEnv } from "./env.ts";

/**
 * Wrap the vendored `skills` CLI (npx skills, vercel-labs/skills).
 * Its global (-g) installs resolve against $HOME, so pointing HOME at the
 * env dir makes skills land inside the environment.
 */
export async function skillCmd(action: string, agent: Agent, name: string, rest: string[]): Promise<number> {
  const dir = requireEnv(agent, name);
  const cli = skillsCliPath();
  if (!fs.existsSync(cli)) {
    throw new Error(`skills CLI not installed at ${cli}\nrun install.sh (or: cd ${shareHint()} && bun add skills)`);
  }
  const flag = skillsAgentFlag(agent);
  let args: string[];

  switch (action) {
    case "add": {
      const [source, ...extra] = rest;
      if (!source) throw new Error("usage: tread skill add <agent> <env> <source> [--skill <name>]...");
      args = ["add", source, "-g", "-a", flag, "-y", "--copy", ...extra];
      break;
    }
    case "ls":
      args = ["list", "-g", "-a", flag];
      break;
    case "rm":
      if (rest.length === 0) throw new Error("usage: tread skill rm <agent> <env> <skill>...");
      args = ["remove", ...rest, "-g", "-y"];
      break;
    case "update":
      args = ["update", ...rest, "-g", "-y"];
      break;
    default:
      throw new Error(`unknown skill action "${action}" (add|ls|rm|update)`);
  }

  const proc = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...process.env, HOME: dir, DISABLE_TELEMETRY: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}

function shareHint(): string {
  return skillsCliPath().replace(/\/node_modules\/skills\/bin\/cli\.mjs$/, "");
}
