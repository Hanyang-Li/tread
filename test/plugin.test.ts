import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-test-plugin-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  process.env.TREAD_SHARE_DIR = path.join(tmp, "share");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { layout } = await import("../src/paths.ts");
const { createEnv } = await import("../src/env.ts");
const { marketplaceEntries, readJson } = await import("../src/plugin/market.ts");
const { kimiPlugin } = await import("../src/plugin/kimi.ts");
const { cursorPlugin } = await import("../src/plugin/cursor.ts");

describe("marketplaceEntries", () => {
  test("bare array and {plugins:[...]} shapes", () => {
    expect(marketplaceEntries([{ name: "a" }])).toHaveLength(1);
    expect(marketplaceEntries({ plugins: [{ name: "a" }, { name: "b" }] })).toHaveLength(2);
    expect(marketplaceEntries({})).toHaveLength(0);
    expect(marketplaceEntries(null)).toHaveLength(0);
  });
});

describe("kimi plugin direct install", () => {
  function makePlugin(name: string): string {
    const src = path.join(tmp, `src-${name}`);
    fs.mkdirSync(path.join(src, "skills", "s1"), { recursive: true });
    fs.writeFileSync(path.join(src, "kimi.plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    fs.writeFileSync(path.join(src, "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: d\n---\n");
    return src;
  }

  test("add from local path writes managed copy + installed.json record", async () => {
    createEnv("kimi", "kp");
    const src = makePlugin("My-Tool");
    const code = await kimiPlugin("add", "kp", [src]);
    expect(code).toBe(0);

    const env = path.join(process.env.TREAD_STATE_DIR!, "kimi", "kp");
    const managed = path.join(layout("kimi", env).pluginsDir, "managed", "my-tool");
    expect(fs.existsSync(path.join(managed, "kimi.plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(managed, "skills", "s1", "SKILL.md"))).toBe(true);

    const installed = readJson(path.join(layout("kimi", env).pluginsDir, "installed.json"));
    expect(installed.version).toBe(1);
    expect(installed.plugins).toHaveLength(1);
    const rec = installed.plugins[0];
    expect(rec.id).toBe("my-tool"); // lowercased manifest name
    expect(rec.enabled).toBe(true);
    expect(rec.source).toBe("local-path");
    expect(rec.root).toBe(fs.realpathSync(managed));
    expect(rec.originalSource).toBe(src);
    expect(typeof rec.installedAt).toBe("string");
  });

  test("reinstall keeps enabled/installedAt, refreshes updatedAt", async () => {
    const src = makePlugin("My-Tool");
    await kimiPlugin("add", "kp", [src]);
    const env = path.join(process.env.TREAD_STATE_DIR!, "kimi", "kp");
    const installed = readJson(path.join(layout("kimi", env).pluginsDir, "installed.json"));
    expect(installed.plugins).toHaveLength(1);
    expect(installed.plugins[0].updatedAt).toBeTruthy();
  });

  test("rm removes the record only (kimi behavior)", async () => {
    const code = await kimiPlugin("rm", "kp", ["my-tool"]);
    expect(code).toBe(0);
    const env = path.join(process.env.TREAD_STATE_DIR!, "kimi", "kp");
    const installed = readJson(path.join(layout("kimi", env).pluginsDir, "installed.json"));
    expect(installed.plugins).toHaveLength(0);
    // managed copy intentionally kept, matching kimi's own remove
    expect(fs.existsSync(path.join(layout("kimi", env).pluginsDir, "managed", "my-tool"))).toBe(true);
  });

  test("add fails without manifest", async () => {
    const bad = path.join(tmp, "no-manifest");
    fs.mkdirSync(bad, { recursive: true });
    await expect(kimiPlugin("add", "kp", [bad])).rejects.toThrow(/manifest|kimi\.plugin\.json/);
  });
});

describe("cursor plugin direct install", () => {
  test("add from local marketplace git repo copies plugin + records it", async () => {
    // build a marketplace repo fixture
    const repo = path.join(tmp, "cursor-market");
    fs.mkdirSync(path.join(repo, ".cursor-plugin"), { recursive: true });
    fs.mkdirSync(path.join(repo, "plugins", "cool"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".cursor-plugin", "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "cool", path: "plugins/cool", description: "cool plugin" }] }),
    );
    fs.writeFileSync(path.join(repo, "plugins", "cool", "README.md"), "cool");
    const { run } = await import("../src/plugin/market.ts");
    await run(["git", "init", "-q", repo]);
    await run(["git", "-C", repo, "add", "."]);
    await run(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

    createEnv("cursor", "cp");
    const code = await cursorPlugin("add", "cp", [repo, "cool"]);
    expect(code).toBe(0);

    const env = path.join(process.env.TREAD_STATE_DIR!, "cursor", "cp");
    const pluginsDir = layout("cursor", env).pluginsDir;
    expect(fs.existsSync(path.join(pluginsDir, "cool", "README.md"))).toBe(true);
    const records = readJson(path.join(pluginsDir, ".tread.json"));
    expect(records.cool.marketplace).toBe(repo);
    expect(records.cool.path).toBe("plugins/cool");

    // rm
    expect(await cursorPlugin("rm", "cp", ["cool"])).toBe(0);
    expect(fs.existsSync(path.join(pluginsDir, "cool"))).toBe(false);
    expect(readJson(path.join(pluginsDir, ".tread.json")).cool).toBeUndefined();
  });
});
