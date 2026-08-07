import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-shim-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { writeShims, shimsHealthy, realBinary } = await import("../src/shims.ts");
const { shimsDir } = await import("../src/paths.ts");

describe("shims", () => {
  test("为每个 agent 及其别名各生成一个可执行 shim", () => {
    writeShims();
    for (const n of ["claude", "cursor-agent", "agent", "kimi"]) {
      const p = path.join(shimsDir(), n);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).mode & 0o111).toBeGreaterThan(0);
    }
  });

  test("只有需要 HOME 的 agent 才在 shim 里改 HOME", () => {
    const read = (n: string) => fs.readFileSync(path.join(shimsDir(), n), "utf8");
    // cursor resolves mcp.json / hooks.json through homedir(); kimi finds
    // skills under ~/.agents/skills — both must have HOME moved
    expect(read("cursor-agent")).toContain('HOME="$TREAD_ENV_DIR"');
    expect(read("agent")).toContain('HOME="$TREAD_ENV_DIR"');
    expect(read("kimi")).toContain('HOME="$TREAD_ENV_DIR"');
    // claude keeps everything under CLAUDE_CONFIG_DIR, so it is left alone
    expect(read("claude")).not.toContain('HOME="$TREAD_ENV_DIR"');
  });

  test("shim 注入各自的隔离变量", () => {
    const read = (n: string) => fs.readFileSync(path.join(shimsDir(), n), "utf8");
    expect(read("claude")).toContain("CLAUDE_CONFIG_DIR=");
    expect(read("cursor-agent")).toContain("CURSOR_CONFIG_DIR=");
    expect(read("cursor-agent")).toContain("CURSOR_DATA_DIR=");
    expect(read("kimi")).toContain("KIMI_CODE_HOME=");
  });

  test("未激活时 shim 直接透传给真二进制", () => {
    const body = fs.readFileSync(path.join(shimsDir(), "claude"), "utf8");
    expect(body).toContain('if [ -z "${TREAD_ENV_DIR:-}" ]; then');
    expect(body).toContain('exec "$real" "$@"');
  });

  test("写入幂等：第二次不改文件", () => {
    writeShims();
    expect(writeShims()).toEqual([]);
  });

  test("shimsHealthy 在生成后为真", () => {
    expect(shimsHealthy()).toBe(true);
  });

  test("realBinary 跳过 shim 目录，不会解析到自己", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${shimsDir()}:${prev}`;
    const found = realBinary("claude");
    expect(found).not.toBe(path.join(shimsDir(), "claude"));
    process.env.PATH = prev;
  });

  test("生成的 shim 是合法 sh 脚本", async () => {
    for (const n of ["claude", "cursor-agent", "kimi"]) {
      const p = Bun.spawn(["sh", "-n", path.join(shimsDir(), n)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await p.exited).toBe(0);
    }
  });

  test("shim 真的会把 HOME 和变量传给被调用的程序", async () => {
    // stand in for cursor-agent: a script that prints what it received
    const fakeDir = path.join(tmp, "fakebin");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fake = path.join(fakeDir, "cursor-agent");
    fs.writeFileSync(fake, '#!/bin/sh\necho "HOME=$HOME"\necho "CFG=$CURSOR_CONFIG_DIR"\n', {
      mode: 0o755,
    });

    const prev = process.env.PATH;
    process.env.PATH = `${fakeDir}:${prev}`;
    fs.rmSync(shimsDir(), { recursive: true, force: true });
    writeShims();
    process.env.PATH = prev;

    const envRoot = path.join(tmp, "envs", "probe");
    fs.mkdirSync(envRoot, { recursive: true });
    const p = Bun.spawn([path.join(shimsDir(), "cursor-agent")], {
      env: { ...process.env, TREAD_ENV_DIR: envRoot, PATH: `${fakeDir}:${prev}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain(`HOME=${envRoot}`);
    expect(out).toContain(`CFG=${envRoot}/.cursor`);
  });

  test("未激活时 shim 不改 HOME", async () => {
    const fakeDir = path.join(tmp, "fakebin");
    const prev = process.env.PATH;
    const p = Bun.spawn([path.join(shimsDir(), "cursor-agent")], {
      env: { ...process.env, PATH: `${fakeDir}:${prev}`, TREAD_ENV_DIR: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain(`HOME=${process.env.HOME}`);
  });
});
