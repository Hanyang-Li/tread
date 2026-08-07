import path from "node:path";
import { AGENTS, isAgent, type Agent } from "./agents.ts";
import { lastUsed, listEnvs } from "./env.ts";
import { agentDir, envsDir, skillsDir } from "./paths.ts";
import { hookCount, inventory, MASK, type Inventory } from "./inspect/index.ts";
import { cheapCheck, fullProbe, type ProbeResult } from "./probe.ts";
import {
  color, colorsEnabled, displayWidth, relTime, table, tildify, truncateMiddle,
  type Palette,
} from "./render.ts";

const DASH = "—";

export function palette(): Palette {
  return color(colorsEnabled());
}

/** Counts per category, or nulls when the agent has never been used. */
function counts(inv: Inventory): (string | null)[] {
  if (!inv.used) return [null, null, null, null];
  return [
    String(inv.skills.length),
    String(inv.plugins.length),
    String(inv.mcp.length),
    String(hookCount(inv.hooks)),
  ];
}

/** `tread status <env>` — one environment, all agents. */
export function statusOne(envRoot: string, name: string, active: boolean): string {
  const c = palette();
  const when = relTime(lastUsed()[name] ?? null);
  const head = active ? `${c.brightGreen("active")} · ${when}` : when;
  const rows: string[][] = [["", "skills", "plugins", "mcp", "hooks", ""]];
  for (const a of AGENTS) {
    const inv = inventory(envRoot, a);
    const [s, p, m, h] = counts(inv);
    rows.push([
      a,
      s ?? DASH, p ?? DASH, m ?? DASH, h ?? DASH,
      inv.used ? "" : c.dim("not used yet"),
    ]);
  }
  const body = table(rows, { align: ["left", "right", "right", "right", "right", "left"] });
  return [`${c.bold(name)}    ${c.dim(head)}`, "", ...body, ""].join("\n");
}

/** `tread status` — every environment, one line each. */
export function statusAll(activeName: string | null): string {
  const c = palette();
  const names = listEnvs();
  if (names.length === 0) {
    return "no environments\n\n  tread create <name>\n";
  }
  const used = lastUsed();
  const rows: string[][] = [["", "skills", "plugins", "mcp", "hooks", ""]];
  for (const n of names) {
    const root = path.join(envsDir(), n);
    let s = 0, p = 0, m = 0, h = 0;
    for (const a of AGENTS) {
      const inv = inventory(root, a);
      s += inv.skills.length;
      p += inv.plugins.length;
      m += inv.mcp.length;
      h += hookCount(inv.hooks);
    }
    // always numbers here: mixing "—" and "0" across rows reads as arbitrary.
    // "never used" belongs in the per-agent view, where it is actionable.
    rows.push([
      n,
      String(s), String(p), String(m), String(h),
      n === activeName ? c.brightGreen("active") : c.dim(relTime(used[n] ?? null)),
    ]);
  }
  return (
    table(rows, { align: ["left", "right", "right", "right", "right", "left"] }).join("\n") +
    "\n"
  );
}

/** `tread ls --plain` */
export function lsPlain(activeName: string | null): string {
  const c = palette();
  const names = listEnvs();
  if (names.length === 0) return "no environments\n\n  tread create <name>\n";
  const used = lastUsed();
  const rows = names.map((n) => [
    n === activeName ? c.brightGreen("*") : " ",
    n,
    c.dim(relTime(used[n] ?? null)),
  ]);
  return table(rows).join("\n") + "\n\n  tread use <name>\n";
}

const CATEGORIES = ["skills", "plugins", "mcp", "hooks"] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

/** `tread show <env> --plain` — overview plus where to go next. */
export function showPlain(envRoot: string, name: string, active: boolean): string {
  return (
    statusOne(envRoot, name, active) +
    [
      `  tread skills ${name} claude       list`,
      `  tread mcp ${name} claude <name>   detail`,
      "",
    ].join("\n")
  );
}

export function skillsList(envRoot: string, a: Agent): string {
  const c = palette();
  const items = inventory(envRoot, a).skills;
  if (items.length === 0) return c.dim("0 skills") + "\n";
  const rows = items.map((s) => [
    s.name,
    s.version ?? c.dim(DASH),
    c.dim(s.source ?? DASH),
  ]);
  return (
    table(rows).join("\n") +
    `\n${c.dim(`${items.length} skill${items.length === 1 ? "" : "s"}`)}\n`
  );
}

export function pluginsList(envRoot: string, a: Agent): string {
  const c = palette();
  const items = inventory(envRoot, a).plugins;
  if (items.length === 0) return c.dim("0 plugins") + "\n";
  const rows = items.map((p) => [
    p.enabled ? p.name : `${p.name} ${c.dim("(disabled)")}`,
    p.version ?? c.dim(DASH),
    c.dim(p.marketplace ?? p.marketplaceSource ?? DASH),
  ]);
  return (
    table(rows).join("\n") +
    `\n${c.dim(`${items.length} plugin${items.length === 1 ? "" : "s"}`)}\n`
  );
}

function statusCell(r: ProbeResult, c: Palette): string {
  if (r.state === "ok") return c.green("ok");
  if (r.state === "error") return c.red(r.reason);
  return c.dim("·");
}

export async function mcpList(envRoot: string, a: Agent, probe: boolean): Promise<string> {
  const c = palette();
  const items = inventory(envRoot, a).mcp;
  if (items.length === 0) return c.dim("0 mcp servers") + "\n";
  const results = await Promise.all(
    items.map((s) => (probe ? fullProbe(s) : cheapCheck(s))),
  );
  const rows = items.map((s, i) => {
    const r = results[i];
    const tools = r.state === "ok" && r.tools.length ? c.dim(`${r.tools.length} tools`) : "";
    return [s.name, c.dim(s.transport), statusCell(r, c), tools];
  });
  return table(rows).join("\n") + "\n";
}

export function hooksList(envRoot: string, a: Agent): string {
  const c = palette();
  const items = inventory(envRoot, a).hooks;
  if (items.length === 0) return c.dim("0 hooks") + "\n";
  const rows = items.map((h) => [
    h.event,
    c.dim(h.matchers.length ? h.matchers.join("|") : DASH),
    path.basename(h.command.split(/\s+/)[0] ?? h.command),
  ]);
  const total = hookCount(items);
  return (
    table(rows).join("\n") +
    `\n${c.dim(`${total} hook${total === 1 ? "" : "s"}`)}\n`
  );
}

function kv(pairs: [string, string | null][], c: Palette): string {
  const rows = pairs
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => [`  ${c.dim(k)}`, v!]);
  return table(rows).join("\n");
}

export function skillDetail(envRoot: string, a: Agent, name: string): string {
  const c = palette();
  const s = inventory(envRoot, a).skills.find((x) => x.name === name);
  if (!s) throw new Error(`no skill "${name}" in this environment`);
  const head = `${c.bold(s.name)}${s.version ? `   ${c.dim(s.version)}` : ""}`;
  const desc = s.description ? `\n  ${s.description}\n` : "";
  return (
    head + "\n" + desc + "\n" +
    kv(
      [
        ["source", s.source],
        ["url", s.sourceUrl],
        ["registry", s.registry],
        ["path", tildify(s.path)],
        ["installed", s.installedAt ? s.installedAt.slice(0, 10) : null],
        ["requires", s.requiresBins.length ? s.requiresBins.join(" ") : null],
      ],
      c,
    ) + "\n"
  );
}

export function pluginDetail(envRoot: string, a: Agent, name: string): string {
  const c = palette();
  const p = inventory(envRoot, a).plugins.find((x) => x.name === name);
  if (!p) throw new Error(`no plugin "${name}" in this environment`);
  const head = `${c.bold(p.name)}${p.version ? `   ${c.dim(p.version)}` : ""}`;
  const desc = p.description ? `\n  ${p.description}\n` : "";
  return (
    head + "\n" + desc + "\n" +
    kv(
      [
        ["author", p.author],
        ["marketplace", p.marketplace],
        ["source", p.marketplaceSource],
        ["commit", p.commit],
        ["installed", p.installedAt ? p.installedAt.slice(0, 10) : null],
        ["updated", p.updatedAt ? p.updatedAt.slice(0, 10) : null],
        ["path", p.path ? tildify(p.path) : null],
        ["enabled", p.enabled ? null : "no"],
      ],
      c,
    ) + "\n"
  );
}

export async function mcpDetail(
  envRoot: string,
  a: Agent,
  name: string,
  probe: boolean,
): Promise<string> {
  const c = palette();
  const s = inventory(envRoot, a).mcp.find((x) => x.name === name);
  if (!s) throw new Error(`no mcp server "${name}" in this environment`);
  const r = probe ? await fullProbe(s) : await cheapCheck(s);
  const target =
    s.transport === "http" ? s.url : [s.command, ...s.args].filter(Boolean).join(" ");
  const pairs: [string, string | null][] = [
    ["transport", s.transport],
    [s.transport === "http" ? "url" : "command", target],
    ["latency", r.state === "ok" && r.latencyMs ? `${r.latencyMs} ms` : null],
  ];
  // keys only — the values are credentials
  for (const k of s.headerKeys) pairs.push(["header", `${k}  ${c.dim(MASK)}`]);
  for (const k of s.envKeys) pairs.push(["env", `${k}  ${c.dim(MASK)}`]);
  if (r.state === "ok" && r.tools.length) pairs.push(["tools", String(r.tools.length)]);

  const lines = [`${c.bold(s.name)}   ${statusCell(r, c)}`, "", kv(pairs, c)];
  if (r.state === "ok" && r.tools.length) lines.push("    " + r.tools.join("  "));
  return lines.join("\n") + "\n";
}

export function hookDetail(envRoot: string, a: Agent, event: string): string {
  const c = palette();
  const items = inventory(envRoot, a).hooks.filter((h) => h.event === event);
  if (items.length === 0) throw new Error(`no hook "${event}" in this environment`);
  const out: string[] = [];
  for (const h of items) {
    out.push(c.bold(h.event), "");
    out.push(
      kv(
        [
          ["matcher", h.matchers.length ? h.matchers.join(" | ") : null],
          ["timeout", h.timeout !== null ? `${h.timeout}s` : null],
          ["command", h.command],
          ["source", h.source],
        ],
        c,
      ),
      "",
    );
  }
  return out.join("\n");
}

/** Resolve `[env] [agent] [name]` where env may be omitted when active. */
export function splitTargets(
  args: string[],
): { envName: string | null; agent: Agent | null; name: string | null } {
  const rest = [...args];
  let envName: string | null = null;
  if (rest.length && !isAgent(rest[0])) envName = rest.shift()!;
  const agent = rest.length && isAgent(rest[0]) ? (rest.shift() as Agent) : null;
  const name = rest.length ? rest.shift()! : null;
  return { envName, agent, name };
}

export { AGENTS, agentDir, skillsDir, displayWidth, truncateMiddle };
