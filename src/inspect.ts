import fs from "node:fs";
import { layout, type Agent } from "./paths.ts";
import { requireEnv } from "./env.ts";
import { readJson } from "./plugin/market.ts";

/** Show the hooks configured in an environment (read-only; tread does not install hooks). */
export function showHooks(agent: Agent, name: string): void {
  const dir = requireEnv(agent, name);
  const l = layout(agent, dir);

  if (agent === "kimi") {
    const text = safeRead(l.hooksFile);
    const cfg = text ? Bun.TOML.parse(text) as any : null;
    const hooks: any[] = cfg?.hooks ?? [];
    if (hooks.length === 0) return void console.log("(no hooks)");
    for (const h of hooks) {
      console.log(`${h.event ?? "?"}${h.matcher ? ` [${h.matcher}]` : ""}`);
      console.log(`  ${h.command ?? "?"}`);
    }
    return;
  }

  const json = readJson(l.hooksFile);
  const hooks = json?.hooks;
  if (!hooks || Object.keys(hooks).length === 0) return void console.log("(no hooks)");
  // claude: { Event: [{ matcher, hooks: [{type, command,...}] }] }
  // cursor: { Event: [{ command, matcher?, ... }] }
  for (const [event, groups] of Object.entries<any>(hooks)) {
    for (const g of groups ?? []) {
      const handlers = Array.isArray(g?.hooks) ? g.hooks : [g];
      for (const h of handlers) {
        const matcher = g?.matcher ? ` [${g.matcher}]` : "";
        console.log(`${event}${matcher}`);
        console.log(`  ${h?.command ?? h?.type ?? "?"}`);
      }
    }
  }
}

/** Show the MCP servers configured in an environment (read-only). */
export function showMcp(agent: Agent, name: string): void {
  const dir = requireEnv(agent, name);
  const l = layout(agent, dir);
  const json = readJson(l.mcpFile);
  const servers = json?.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) return void console.log("(no mcp servers)");
  for (const n of names.sort()) {
    const s = servers[n];
    const target = s?.command ? `${s.command} ${(s.args ?? []).join(" ")}`.trim() : s?.url ?? "?";
    console.log(`${n}`);
    console.log(`  ${target}`);
  }
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
