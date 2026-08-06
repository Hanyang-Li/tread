import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { agentDir } from "../paths.ts";
import type { McpServerInfo } from "./types.ts";

/** Config files holding `mcpServers`, per agent, relative to its config dir. */
function sources(a: Agent): string[] {
  return a === "claude" ? [".mcp.json", ".claude.json"] : ["mcp.json"];
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Header values are credentials. They are attached non-enumerably so that
 * probing can use them while JSON.stringify, console.log and every render
 * path see only the keys.
 */
export function rawHeaders(s: McpServerInfo): Record<string, string> {
  return (s as any).__rawHeaders ?? {};
}

export function readMcp(envRoot: string, a: Agent): McpServerInfo[] {
  const byName = new Map<string, McpServerInfo>();
  for (const rel of sources(a)) {
    const servers = readJson(path.join(agentDir(envRoot, a), rel))?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, s] of Object.entries<any>(servers)) {
      const info: McpServerInfo = {
        name,
        transport: s?.url ? "http" : "stdio",
        command: s?.command ?? null,
        args: Array.isArray(s?.args) ? s.args.map(String) : [],
        url: s?.url ?? null,
        headerKeys: Object.keys(s?.headers ?? {}),
        envKeys: Object.keys(s?.env ?? {}),
        source: rel,
      };
      Object.defineProperty(info, "__rawHeaders", {
        value: s?.headers ?? {},
        enumerable: false,
        writable: false,
      });
      byName.set(name, info);
    }
  }
  return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
}
