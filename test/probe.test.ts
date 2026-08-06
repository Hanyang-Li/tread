import { describe, expect, test } from "bun:test";
import type { McpServerInfo } from "../src/inspect/types.ts";
const { cheapCheck, fullProbe } = await import("../src/probe.ts");

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
    const r = await fullProbe(stdio("/usr/bin/true"), 1000);
    expect(r.state).toBe("error");
    expect((r as any).reason).toContain("no MCP response");
  }, 5000);

  test("stdio: 命令不存在直接失败", async () => {
    expect((await fullProbe(stdio("/definitely/not/here"), 300)).state).toBe("error");
  });
});
