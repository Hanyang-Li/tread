import path from "node:path";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { AGENTS, type Agent } from "../agents.ts";
import { requireEnv } from "../env.ts";
import { commandLabel, hookCount, inventory, MASK, type Inventory } from "../inspect/index.ts";
import { cheapCheck, fullProbe, type ProbeResult } from "../probe.ts";
import { displayWidth, tildify } from "../render.ts";
import { mount } from "./mount.ts";
import { pickLayout, scrollWindow } from "./layout.ts";
import { TooSmall } from "./TooSmall.tsx";
import { BG, BORDER, FG } from "./theme.ts";

const CATEGORIES = ["skills", "plugins", "mcp", "hooks"] as const;
type Category = (typeof CATEGORIES)[number];

type Node =
  | { kind: "section"; cat: Category; count: number }
  | { kind: "item"; cat: Category; index: number; cells: string[] };

function countOf(inv: Inventory, cat: Category): number {
  return cat === "skills" ? inv.skills.length
    : cat === "plugins" ? inv.plugins.length
    : cat === "mcp" ? inv.mcp.length
    : hookCount(inv.hooks);
}

function statusText(r: ProbeResult | undefined): string {
  if (!r) return "·";
  if (r.state === "ok") return "ok";
  if (r.state === "error") return r.reason;
  return "·";
}

function rowsOf(
  inv: Inventory,
  cat: Category,
  probes: Record<string, ProbeResult>,
  columns: number,
): string[][] {
  const trim = (s: string[]) => s.slice(0, columns);
  switch (cat) {
    case "skills":
      return inv.skills.map((s) => trim([s.name, s.version ?? "—", s.source ?? "—"]));
    case "plugins":
      return inv.plugins.map((p) =>
        trim([p.name, p.version ?? "—", p.marketplace ?? p.marketplaceSource ?? "—"]),
      );
    case "mcp":
      return inv.mcp.map((m) => trim([m.name, m.transport, statusText(probes[m.name])]));
    case "hooks":
      return inv.hooks.map((h) =>
        trim([
          h.event,
          h.matchers.length ? h.matchers.join("│") : "—",
          commandLabel(h.command),
        ]),
      );
  }
}

/**
 * Break a value into lines that fit. Prefers a space, since a command reads
 * better split between arguments, but falls back to a hard cut — a long path
 * has no spaces and still has to be readable in full.
 */
function wrapValue(v: string, max: number): string[] {
  if (max <= 0) return [v];
  const lines: string[] = [];
  let rest = v;
  while (displayWidth(rest) > max) {
    let cut = 0;
    let taken = "";
    for (const ch of rest) {
      if (displayWidth(taken + ch) > max) break;
      taken += ch;
      cut += ch.length;
    }
    const space = taken.lastIndexOf(" ");
    if (space > max / 2) cut = space + 1;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut);
  }
  lines.push(rest);
  return lines;
}

function detailOf(
  inv: Inventory,
  cat: Category,
  index: number,
  probes: Record<string, ProbeResult>,
): { title: string; badge: string; body: string | null; pairs: [string, string][] } {
  const pairs: [string, string][] = [];
  const push = (k: string, v: string | null | undefined) => {
    if (v) pairs.push([k, v]);
  };

  if (cat === "skills") {
    const s = inv.skills[index]!;
    push("source", s.source);
    push("url", s.sourceUrl);
    push("registry", s.registry);
    push("path", tildify(s.path));
    push("installed", s.installedAt?.slice(0, 10));
    push("requires", s.requiresBins.join(" "));
    return { title: s.name, badge: s.version ?? "", body: s.description, pairs };
  }
  if (cat === "plugins") {
    const p = inv.plugins[index]!;
    push("author", p.author);
    push("marketplace", p.marketplace);
    push("source", p.marketplaceSource);
    push("commit", p.commit);
    push("installed", p.installedAt?.slice(0, 10));
    push("updated", p.updatedAt?.slice(0, 10));
    push("path", p.path ? tildify(p.path) : null);
    if (!p.enabled) push("enabled", "no");
    return { title: p.name, badge: p.version ?? "", body: p.description, pairs };
  }
  if (cat === "mcp") {
    const m = inv.mcp[index]!;
    const r = probes[m.name];
    push("transport", m.transport);
    push(
      m.transport === "http" ? "url" : "command",
      m.transport === "http" ? m.url : [m.command, ...m.args].filter(Boolean).join(" "),
    );
    if (r?.state === "ok" && r.latencyMs) push("latency", `${r.latencyMs} ms`);
    for (const k of m.headerKeys) pairs.push(["header", `${k}  ${MASK}`]);
    for (const k of m.envKeys) pairs.push(["env", `${k}  ${MASK}`]);
    if (r?.state === "ok" && r.tools.length) {
      pairs.push(["tools", String(r.tools.length)]);
      pairs.push(["", r.tools.join("  ")]);
    }
    const badge =
      r?.state === "ok" ? (m.transport === "http" ? "● connected" : "● responds")
      : r?.state === "error" ? `✗ ${r.reason}`
      : "· not checked";
    return { title: m.name, badge, body: null, pairs };
  }
  const h = inv.hooks[index]!;
  push("matcher", h.matchers.join(" | "));
  push("timeout", h.timeout !== null ? `${h.timeout}s` : null);
  push("command", h.command);
  push("source", h.source);
  return { title: h.event, badge: "", body: null, pairs };
}

export function EnvBrowser({
  name,
  onBack,
  onQuit,
  width,
  height,
}: {
  name: string;
  onBack: (() => void) | null;
  onQuit: () => void;
  width: number;
  height: number;
}) {
  const root = useMemo(() => requireEnv(name), [name]);
  const [agentIdx, setAgentIdx] = useState(0);
  const [open, setOpen] = useState<Set<Category>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<{ cat: Category; index: number } | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [probing, setProbing] = useState(false);

  const agent: Agent = AGENTS[agentIdx]!;
  const inv = useMemo(() => inventory(root, agent), [root, agent]);
  const layout = pickLayout(width, height);

  // cheap, side-effect-free checks only: for stdio this is "can the command
  // run", never a spawn. `t` runs the real handshake on demand.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, ProbeResult> = {};
      for (const m of inv.mcp) out[m.name] = await cheapCheck(m);
      if (!cancelled) setProbes(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [inv]);

  const nodes = useMemo<Node[]>(() => {
    const list: Node[] = [];
    for (const cat of CATEGORIES) {
      list.push({ kind: "section", cat, count: countOf(inv, cat) });
      if (!open.has(cat)) continue;
      rowsOf(inv, cat, probes, layout.columns).forEach((cells, index) => {
        list.push({ kind: "item", cat, index, cells });
      });
    }
    return list;
  }, [inv, open, probes, layout.columns]);

  const runProbe = useCallback(async () => {
    setProbing(true);
    const out: Record<string, ProbeResult> = {};
    for (const m of inv.mcp) out[m.name] = await fullProbe(m);
    setProbes(out);
    setProbing(false);
  }, [inv]);

  useKeyboard(
    useCallback(
      (key) => {
        // every binding here is an unmodified key, so a chord is never meant
        // for us — without this, Ctrl+L would switch agent instead of doing
        // whatever the terminal does with it
        if (key.ctrl || key.meta) return;
        if (detail) {
          if (key.name === "escape" || key.name === "backspace") setDetail(null);
          else if (key.name === "q") onQuit();
          return;
        }
        const node = nodes[cursor];
        switch (key.name) {
          case "up":
          case "k":
            setCursor((c) => Math.max(0, c - 1));
            break;
          case "down":
          case "j":
            setCursor((c) => Math.min(nodes.length - 1, c + 1));
            break;
          case "left":
          case "h":
            setAgentIdx((i) => (i + AGENTS.length - 1) % AGENTS.length);
            setCursor(0);
            break;
          case "right":
          case "l":
            setAgentIdx((i) => (i + 1) % AGENTS.length);
            setCursor(0);
            break;
          // space is the one "open this" key: on a section it folds, on a
          // row it drills in. The two can never apply to the same node.
          case "space":
          case "return":
            if (node?.kind === "item") setDetail({ cat: node.cat, index: node.index });
            else if (node?.kind === "section") {
              setOpen((s) => {
                const next = new Set(s);
                next.has(node.cat) ? next.delete(node.cat) : next.add(node.cat);
                return next;
              });
            }
            break;
          case "t":
            void runProbe();
            break;
          case "escape":
            onBack ? onBack() : onQuit();
            break;
          case "q":
            onQuit();
            break;
        }
      },
      [nodes, cursor, detail, onBack, onQuit, runProbe],
    ),
  );

  if (layout.mode === "plain") return <TooSmall width={width} height={height} />;

  if (detail) {
    const d = detailOf(inv, detail.cat, detail.index, probes);
    const labelWidth = Math.max(0, ...d.pairs.map(([k]) => k.length));
    const maxVal = Math.max(10, width - labelWidth - 8);
    return (
      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={BORDER}
        title={` ${name} · ${agent} · ${detail.cat.replace(/s$/, "")} `}
        bottomTitle=" esc back   q quit "
        padding={1}
      >
        <box flexDirection="row">
          <text fg={FG.normal} attributes={1}>
            {d.title}
          </text>
          {d.badge ? <text fg={FG.dim}>{`   ${d.badge}`}</text> : null}
        </box>
        {d.body ? (
          <text fg={FG.normal} marginTop={1} wrapMode="word">
            {d.body}
          </text>
        ) : null}
        <box flexDirection="column" marginTop={1}>
          {d.pairs.map(([k, v], i) => (
            <box key={`${k}-${i}`} flexDirection="column">
              {/* the detail view exists to show the whole value; a command or
                  path elided in the middle is exactly the thing you opened it
                  to read, so wrap onto continuation lines instead */}
              {wrapValue(v, maxVal).map((line, j) => (
                <box key={j} flexDirection="row">
                  <text fg={FG.dim}>{(j === 0 ? k : "").padEnd(labelWidth + 2)}</text>
                  <text fg={FG.normal}>{line}</text>
                </box>
              ))}
            </box>
          ))}
        </box>
      </box>
    );
  }

  const win = scrollWindow(cursor, nodes.length, Math.max(1, height - 6));
  const visible = nodes.slice(win.start, win.end);
  const itemWidths: number[] = [];
  for (const n of nodes) {
    if (n.kind !== "item") continue;
    n.cells.forEach((c, i) => {
      itemWidths[i] = Math.max(itemWidths[i] ?? 0, c.length);
    });
  }

  const footer =
    layout.mode === "minimal"
      ? " ←→ ↑↓ ␣ t esc q "
      : " ←→ agent   ↑↓ move   ␣ fold / detail   t probe mcp   esc back   q quit ";

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={BORDER}
      title={probing ? ` ${name} (probing…) ` : ` ${name} `}
      bottomTitle={footer}
      padding={1}
    >
      <box flexDirection="row">
        {AGENTS.map((a, i) => (
          <box key={a} backgroundColor={i === agentIdx ? BG.select : undefined}>
            <text fg={i === agentIdx ? FG.onSelect : FG.dim}>{` ${a} `}</text>
          </box>
        ))}
      </box>

      <box flexDirection="column" marginTop={1}>
        {visible.map((n, i) => {
          const idx = win.start + i;
          const sel = idx === cursor;
          if (n.kind === "section") {
            return (
              <box
                key={`s-${n.cat}`}
                flexDirection="row"
                backgroundColor={sel ? BG.select : undefined}
              >
                <text fg={sel ? FG.onSelect : FG.dim}>
                  {`  ${open.has(n.cat) ? "▾" : "▸"}  `}
                </text>
                <text fg={sel ? FG.onSelect : FG.normal}>{n.cat.padEnd(9)}</text>
                <text fg={sel ? FG.onSelect : FG.dim}>{String(n.count)}</text>
              </box>
            );
          }
          return (
            <box
              key={`i-${n.cat}-${n.index}`}
              flexDirection="row"
              backgroundColor={sel ? BG.select : undefined}
            >
              <text fg={sel ? FG.onSelect : FG.normal}>{"       "}</text>
              {n.cells.map((cell, ci) => (
                <text
                  key={ci}
                  fg={sel ? FG.onSelect : ci === 0 ? FG.normal : FG.dim}
                >
                  {cell.padEnd((itemWidths[ci] ?? 0) + 3)}
                </text>
              ))}
            </box>
          );
        })}
      </box>
    </box>
  );
}

function Show({ name, exit }: { name: string; exit: (code?: number) => void }) {
  const { width, height } = useTerminalDimensions();
  return (
    <EnvBrowser
      name={name}
      onBack={null}
      onQuit={() => exit(0)}
      width={width}
      height={height}
    />
  );
}

export async function mountShow(_root: string, name: string): Promise<number> {
  return await mount((exit) => <Show name={name} exit={exit} />);
}
