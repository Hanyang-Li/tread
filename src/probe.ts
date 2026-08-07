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

/** A refusal from the server itself, as opposed to never reaching it. */
function isProtocolError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /^\d{3} /.test(m) || m === "no initialize response";
}

/** Full MCP handshake. Spawns stdio servers, so only run on explicit request. */
export async function fullProbe(s: McpServerInfo, timeoutMs = 10000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    let tools: string[];
    if (s.transport === "stdio") {
      tools = await probeStdio(s, timeoutMs);
    } else {
      try {
        tools = await probeHttp(s, timeoutMs);
      } catch (e) {
        // transport-level failures are worth a second opinion; protocol-level
        // ones (an error frame from the server) are not
        if (!resolveBin("curl") || isProtocolError(e)) throw e;
        tools = await probeHttpViaCurl(s, timeoutMs);
      }
    }
    return { state: "ok", tools, latencyMs: Date.now() - started };
  } catch (e) {
    return { state: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}


/**
 * Read a Streamable HTTP response until the awaited JSON-RPC id arrives, then
 * let go. These servers answer over SSE and hold the stream open, so draining
 * the body never returns — it just burns the timeout and surfaces as a
 * protocol error.
 */
async function readFrames(
  body: ReadableStream<Uint8Array> | null | undefined,
  ids: number[],
  timeoutMs: number,
  onHeader?: (line: string) => void,
): Promise<Map<number, any>> {
  const found = new Map<number, any>();
  const reader = body?.getReader();
  if (!reader) return found;
  const want = new Set(ids);
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  let json = "";

  /** Record a reply if the text is one we are waiting for. */
  const take = (text: string): boolean => {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return false;
    }
    if (typeof msg?.id !== "number" || !want.has(msg.id)) return false;
    // a reply carries result or error; a request carries method. Without
    // this an echo server would look like a working MCP server.
    if (msg.method !== undefined) return false;
    if (!("result" in msg) && !("error" in msg)) return false;
    found.set(msg.id, msg);
    want.delete(msg.id);
    return true;
  };

  try {
    while (want.size && Date.now() < deadline) {
      const left = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), left)),
      ]);
      const done = !chunk || chunk.done;
      if (chunk && !chunk.done) buf += decoder.decode(chunk.value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!payload.startsWith("{") && !json) {
          onHeader?.(line);
          continue;
        }
        // one frame per line (SSE / JSONL), or a body pretty-printed across
        // several lines — accumulate until it parses
        if (take(payload)) {
          json = "";
          continue;
        }
        json += payload;
        if (take(json)) json = "";
      }
      if (take(json + buf.trim())) {
        json = "";
        buf = "";
      }
      if (done) break;
    }
    return found;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

/**
 * Same handshake over curl.
 *
 * Bun's fetch has no socks5 support and rejects a CONNECT reply that carries
 * `Transfer-Encoding: chunked` — which some local proxies emit — as an
 * invalid HTTP response. curl tolerates both and reads proxy settings from
 * the same environment, so it is the fallback rather than a hard failure.
 */
async function probeHttpViaCurl(s: McpServerInfo, timeoutMs: number): Promise<string[]> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const headerArgs: string[] = [
    "-H", "content-type: application/json",
    "-H", "accept: application/json, text/event-stream",
  ];
  for (const [k, v] of Object.entries(rawHeaders(s))) headerArgs.push("-H", `${k}: ${v}`);

  const call = (body: unknown, extra: string[], includeHeaders: boolean) =>
    Bun.spawn(
      [
        "curl", "-sS", "--no-buffer", "--max-time", String(seconds),
        ...(includeHeaders ? ["-i"] : []),
        "-X", "POST", s.url!, ...headerArgs, ...extra,
        "--data-binary", JSON.stringify(body),
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );

  let session: string | null = null;
  const initProc = call(INIT, [], true);
  const ackFrames = await readFrames(initProc.stdout, [1], timeoutMs, (line) => {
    const m = line.match(/^mcp-session-id:\s*(.+)$/i);
    if (m) session = m[1].trim();
  });
  const ack = ackFrames.get(1);
  const initErr = (await new Response(initProc.stderr).text()).trim();
  initProc.kill();
  if (!ack) throw new Error(initErr || "no initialize response");
  if (ack.error?.message) throw new Error(String(ack.error.message));

  const listProc = call(LIST, session ? ["-H", `mcp-session-id: ${session}`] : [], false);
  const msg = (await readFrames(listProc.stdout, [2], timeoutMs)).get(2);
  listProc.kill();
  return (msg?.result?.tools ?? [])
    .map((t: any) => t?.name)
    .filter((n: unknown): n is string => typeof n === "string");
}

async function probeHttp(s: McpServerInfo, timeoutMs: number): Promise<string[]> {
  const base: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...rawHeaders(s),
  };
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(s.url!, {
      method: "POST",
      headers: { ...base, ...extra },
      body: JSON.stringify(body),
      // the body is read incrementally, so only the connect phase gets this
      signal: AbortSignal.timeout(timeoutMs),
    });

  const init = await post(INIT);
  if (!init.ok) throw new Error(`${init.status} ${init.statusText.toLowerCase()}`.trim());
  const ack = (await readFrames(init.body, [1], timeoutMs)).get(1);
  if (!ack) throw new Error("no initialize response");
  if (ack.error?.message) throw new Error(String(ack.error.message));

  // Streamable HTTP binds later calls to the session opened by initialize
  const session = init.headers.get("mcp-session-id");
  const withSession: Record<string, string> = session ? { "mcp-session-id": session } : {};

  try {
    const list = await post(LIST, withSession);
    if (!list.ok) return [];
    const msg = (await readFrames(list.body, [2], timeoutMs)).get(2);
    return (msg?.result?.tools ?? [])
      .map((t: any) => t?.name)
      .filter((n: unknown): n is string => typeof n === "string");
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
    // an MCP server stays alive after replying, so reading to EOF would
    // always hit the timeout — read until the frames we asked for arrive
    // one reader for both replies: a stream can only be locked once
    const frames = await readFrames(proc.stdout, [1, 2], timeoutMs);
    const ack = frames.get(1);
    if (!ack) throw new Error(`timeout (${timeoutMs}ms)`);
    if (ack.error?.message) throw new Error(String(ack.error.message));
    return (frames.get(2)?.result?.tools ?? [])
      .map((t: any) => t?.name)
      .filter((n: unknown): n is string => typeof n === "string");
  } finally {
    kill();
  }
}
