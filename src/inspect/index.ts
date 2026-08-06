import fs from "node:fs";
import type { Agent } from "../agents.ts";
import { agentDir } from "../paths.ts";
import { SKELETON_ENTRIES } from "../env.ts";
import { readSkills } from "./skills.ts";
import { readPlugins } from "./plugins.ts";
import { readMcp } from "./mcp.ts";
import { readHooks } from "./hooks.ts";
import type { Inventory } from "./types.ts";

/**
 * An agent counts as used once it holds anything beyond tread's own skeleton.
 * For claude this doubles as "you have not logged in here yet".
 */
function hasBeenUsed(envRoot: string, a: Agent): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(agentDir(envRoot, a));
  } catch {
    return false;
  }
  return entries.some((e) => !SKELETON_ENTRIES.has(e));
}

export function inventory(envRoot: string, a: Agent): Inventory {
  return {
    skills: readSkills(envRoot, a),
    plugins: readPlugins(envRoot, a),
    mcp: readMcp(envRoot, a),
    hooks: readHooks(envRoot, a),
    used: hasBeenUsed(envRoot, a),
  };
}

export * from "./types.ts";
export { readSkills } from "./skills.ts";
export { readPlugins } from "./plugins.ts";
export { readMcp, rawHeaders } from "./mcp.ts";
export { readHooks, hookCount, hookFile } from "./hooks.ts";
