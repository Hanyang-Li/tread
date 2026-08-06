import fs from "node:fs";
import path from "node:path";
import { rawHeaders } from "./inspect/mcp.ts";
import type { McpServerInfo } from "./inspect/types.ts";

export type ProbeResult =
  | { state: "ok"; tools: string[]; latencyMs: number }
  | { state: "error"; reason: string }
  | { state: "unchecked" };

function resolveBin(command: string): string | null {
  if (command.includes("/")) return fs.existsSync(command) ? command : null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, command);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Free, side-effect-free check.
 *
 * A stdio MCP server has no steady-state "connection" to observe — the agent
 * spawns one per session — so probing it would mean starting an instance.
 * The only honest cheap signal is whether its command exists and can run.
 * http servers are real endpoints, but reaching them sends credentials, so
 * that is left to fullProbe.
 */
export async function cheapCheck(s: McpServerInfo): Promise<ProbeResult> {
  if (s.transport === "http") return { state: "unchecked" };
  if (!s.command) return { state: "error", reason: "no command" };
  const bin = resolveBin(s.command);
  if (!bin) return { state: "error", reason: `not found: ${s.command}` };
  if (!executable(bin)) return { state: "error", reason: `not executable: ${s.command}` };
  return { state: "ok", tools: [], latencyMs: 0 };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tread", version: "0.2.0" },
  },
};
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

/** Full MCP handshake. Spawns stdio servers, so only run on explicit request. */
export async function fullProbe(s: McpServerInfo, timeoutMs = 3000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const tools =
      s.transport === "http"
        ? await probeHttp(s, timeoutMs)
        : await probeStdio(s, timeoutMs);
    return { state: "ok", tools, latencyMs: Date.now() - started };
  } catch (e) {
    return { state: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

function collectTools(text: string): { tools: string[]; sawResponse: boolean } {
  const tools: string[] = [];
  let sawResponse = false;
  for (const line of text.split("\n")) {
    const t = line.trim().replace(/^data:\s*/, "");
    if (!t.startsWith("{")) continue;
    let msg: any;
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }
    if (msg?.id === 1 || msg?.id === 2) sawResponse = true;
    for (const tool of msg?.result?.tools ?? []) {
      if (tool?.name) tools.push(String(tool.name));
    }
  }
  return { tools, sawResponse };
}

async function probeHttp(s: McpServerInfo, timeoutMs: number): Promise<string[]> {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...rawHeaders(s),
  };
  const post = (body: unknown) =>
    fetch(s.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const init = await post(INIT);
  if (!init.ok) throw new Error(`${init.status} ${init.statusText.toLowerCase()}`.trim());
  await init.text();

  try {
    const list = await post(LIST);
    if (!list.ok) return [];
    return collectTools(await list.text()).tools;
  } catch {
    return [];
  }
}

async function probeStdio(s: McpServerInfo, timeoutMs: number): Promise<string[]> {
  const bin = resolveBin(s.command!);
  if (!bin) throw new Error(`not found: ${s.command}`);
  const proc = Bun.spawn([bin, ...s.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env },
  });
  const kill = () => {
    try {
      proc.kill();
    } catch {}
  };
  try {
    proc.stdin.write(JSON.stringify(INIT) + "\n");
    proc.stdin.write(JSON.stringify(LIST) + "\n");
    await proc.stdin.flush();
    const text = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((_, rej) =>
        setTimeout(() => {
          kill();
          rej(new Error(`timeout (${timeoutMs}ms)`));
        }, timeoutMs),
      ),
    ]);
    const { tools, sawResponse } = collectTools(text);
    if (!sawResponse) throw new Error("no MCP response");
    return tools;
  } finally {
    kill();
  }
}
