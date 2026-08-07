import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerInfo } from "../src/inspect/types.ts";
const { cheapCheck, fullProbe } = await import("../src/probe.ts");

let tmp: string;
let fakeServer: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-probe-"));
  fakeServer = path.join(tmp, "fake-mcp.mjs");
  // answers the handshake and then stays alive, like a real stdio MCP server
  fs.writeFileSync(
    fakeServer,
    [
      'process.stdin.on("data", (b) => {',
      '  for (const line of String(b).split("\\n")) {',
      '    if (!line.trim().startsWith("{")) continue;',
      "    const m = JSON.parse(line);",
      '    if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1,',
      '      result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");',
      '    if (m.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2,',
      '      result: { tools: [{ name: "alpha" }, { name: "beta" }] } }) + "\\n");',
      "  }",
      "});",
      "setInterval(() => {}, 1 << 30);",
    ].join("\n"),
  );
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const stdio = (command: string): McpServerInfo => ({
  name: "s",
  transport: "stdio",
  command,
  args: [],
  url: null,
  headerKeys: [],
  envKeys: [],
  source: "x",
});

describe("cheapCheck", () => {
  test("stdio: 命令不存在", async () => {
    const r = await cheapCheck(stdio("/definitely/not/here"));
    expect(r.state).toBe("error");
    expect((r as any).reason).toContain("not found");
  });

  test("stdio: 存在且可执行", async () => {
    expect((await cheapCheck(stdio("/bin/echo"))).state).toBe("ok");
  });

  test("stdio: PATH 上的裸命令名也能解析", async () => {
    expect((await cheapCheck(stdio("echo"))).state).toBe("ok");
  });

  test("stdio: 存在但不可执行", async () => {
    expect((await cheapCheck(stdio("/etc/hosts"))).state).toBe("error");
  });

  test("http: 不做网络请求，返回 unchecked", async () => {
    const r = await cheapCheck({ ...stdio(""), transport: "http", url: "https://x" });
    expect(r.state).toBe("unchecked");
  });
});

describe("fullProbe", () => {
  test("stdio: 不说 MCP 协议的进程在超时内被判失败且不挂起", async () => {
    const r = await fullProbe(stdio("/bin/cat"), 300);
    expect(r.state).toBe("error");
  }, 5000);

  test("stdio: 立即退出且无输出的进程判失败", async () => {
    expect((await fullProbe(stdio("/usr/bin/true"), 1000)).state).toBe("error");
  }, 5000);

  test("stdio: 只回声不说协议的进程不能被当成可用", async () => {
    // cat echoes our own request back, which carries id:1 — a naive parser
    // would read that as a reply
    const r = await fullProbe(stdio("/bin/cat"), 800);
    expect(r.state).toBe("error");
  }, 5000);

  test("stdio: 应答后仍存活的真 MCP server 能读到工具，不等它退出", async () => {
    const fake: McpServerInfo = {
      ...stdio(process.execPath),
      args: [fakeServer],
    };
    const started = Date.now();
    const r = await fullProbe(fake, 8000);
    expect(r.state).toBe("ok");
    expect((r as any).tools).toEqual(["alpha", "beta"]);
    // must not have waited out the timeout
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15000);

  test("stdio: 命令不存在直接失败", async () => {
    expect((await fullProbe(stdio("/definitely/not/here"), 300)).state).toBe("error");
  });
});
