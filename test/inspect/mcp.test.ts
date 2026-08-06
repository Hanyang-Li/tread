import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-mcp-"));
  for (const d of [".claude", ".cursor", ".kimi-code"]) {
    fs.mkdirSync(path.join(env, d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(env, ".claude/.mcp.json"),
    JSON.stringify({
      mcpServers: {
        local: { command: "/bin/echo", args: ["hi"], env: { TOKEN: "secret" } },
      },
    }),
  );
  fs.writeFileSync(
    path.join(env, ".claude/.claude.json"),
    JSON.stringify({ mcpServers: { extra: { command: "/bin/true" } } }),
  );
  fs.writeFileSync(
    path.join(env, ".cursor/mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: { url: "https://x/mcp", headers: { "X-API-Key": "sk-real-secret" } },
      },
    }),
  );
  fs.writeFileSync(path.join(env, ".kimi-code/mcp.json"), "{ not json");
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readMcp, rawHeaders } = await import("../../src/inspect/mcp.ts");

describe("readMcp", () => {
  test("stdio 服务器解析 command/args，只留 env 的 key", () => {
    const s = readMcp(env, "claude").find((x) => x.name === "local")!;
    expect(s.transport).toBe("stdio");
    expect(s.command).toBe("/bin/echo");
    expect(s.args).toEqual(["hi"]);
    expect(s.envKeys).toEqual(["TOKEN"]);
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  test("claude 合并 .mcp.json 与 .claude.json", () => {
    expect(readMcp(env, "claude").map((s) => s.name)).toEqual(["extra", "local"]);
  });

  test("http 服务器只留 header 的 key，序列化绝不含明文值", () => {
    const s = readMcp(env, "cursor")[0];
    expect(s.transport).toBe("http");
    expect(s.url).toBe("https://x/mcp");
    expect(s.headerKeys).toEqual(["X-API-Key"]);
    expect(JSON.stringify(s)).not.toContain("sk-real-secret");
    expect(Object.keys(s)).not.toContain("__rawHeaders");
  });

  test("rawHeaders 仅通过显式访问器暴露，供探测使用", () => {
    const s = readMcp(env, "cursor")[0];
    expect(rawHeaders(s)["X-API-Key"]).toBe("sk-real-secret");
  });

  test("坏 JSON 不抛异常，返回空", () => {
    expect(readMcp(env, "kimi")).toEqual([]);
  });
});
