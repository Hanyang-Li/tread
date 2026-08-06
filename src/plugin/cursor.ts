import fs from "node:fs";
import path from "node:path";
import { layout } from "../paths.ts";
import { requireEnv } from "../env.ts";
import { cacheMarketplace, copyDir, marketplaceEntries, readJson, writeJson } from "./market.ts";

interface CursorPluginRecord {
  marketplace: string;
  path: string;
}

function recordFile(envDir: string): string {
  return path.join(layout("cursor", envDir).pluginsDir, ".tread.json");
}

function loadRecords(envDir: string): Record<string, CursorPluginRecord> {
  return readJson(recordFile(envDir)) ?? {};
}

/** Repo-relative path of a plugin entry in a cursor marketplace.json (tolerant). */
function entryPath(entry: any): string | null {
  const src = entry?.source ?? entry?.path ?? entry?.dir;
  if (typeof src === "string") return src;
  if (src && typeof src.path === "string") return src.path;
  return null;
}

/**
 * cursor-agent has marketplace CLI commands but no install command;
 * plugins are loaded from local dirs via `--plugin-dir`. tread fetches
 * marketplace repos itself and copies plugins into <env>/plugins/.
 */
export async function cursorPlugin(action: string, envName: string, args: string[]): Promise<number> {
  const dir = requireEnv("cursor", envName);
  const pluginsDir = layout("cursor", dir).pluginsDir;

  switch (action) {
    case "add": {
      const [url, pluginName] = args;
      if (!url) throw new Error("usage: tread plugin add cursor <env> <marketplace-git-url> [plugin-name]");
      const repo = await cacheMarketplace(url);
      const manifest = readJson(path.join(repo, ".cursor-plugin/marketplace.json"));
      const entries = marketplaceEntries(manifest);
      if (entries.length === 0) throw new Error(`no plugins found in ${url} (.cursor-plugin/marketplace.json)`);
      if (!pluginName) {
        console.log(`plugins in ${url}:`);
        for (const e of entries) console.log(`  ${e?.name ?? "?"}${e?.description ? ` — ${e.description}` : ""}`);
        console.log(`\ninstall one with: tread plugin add cursor ${envName} ${url} <name>`);
        return 0;
      }
      const entry = entries.find((e: any) => e?.name === pluginName);
      if (!entry) throw new Error(`plugin "${pluginName}" not found in ${url}`);
      const rel = entryPath(entry) ?? pluginName;
      const src = path.join(repo, rel);
      if (!fs.existsSync(src)) throw new Error(`plugin path not found in repo: ${rel}`);
      copyDir(src, path.join(pluginsDir, pluginName));
      const records = loadRecords(dir);
      records[pluginName] = { marketplace: url, path: rel };
      writeJson(recordFile(dir), records);
      console.log(`installed ${pluginName} → ${path.join(pluginsDir, pluginName)}`);
      console.log(`it will be loaded via --plugin-dir on next 'tread run cursor ${envName}'`);
      return 0;
    }
    case "ls": {
      const records = loadRecords(dir);
      const names = fs.existsSync(pluginsDir)
        ? fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        : [];
      if (names.length === 0) {
        console.log("(no plugins)");
        return 0;
      }
      for (const n of names.sort()) {
        const r = records[n];
        console.log(r ? `${n}  (${r.marketplace})` : n);
      }
      return 0;
    }
    case "rm": {
      const [name] = args;
      if (!name) throw new Error("usage: tread plugin rm cursor <env> <name>");
      fs.rmSync(path.join(pluginsDir, name), { recursive: true, force: true });
      const records = loadRecords(dir);
      delete records[name];
      writeJson(recordFile(dir), records);
      console.log(`removed ${name}`);
      return 0;
    }
    case "update": {
      const records = loadRecords(dir);
      const names = Object.keys(records);
      if (names.length === 0) {
        console.log("(no plugins)");
        return 0;
      }
      for (const url of new Set(names.map((n) => records[n].marketplace))) {
        await cacheMarketplace(url); // pulls latest
      }
      for (const n of names) {
        const r = records[n];
        const repo = await cacheMarketplace(r.marketplace);
        copyDir(path.join(repo, r.path), path.join(pluginsDir, n));
        console.log(`updated ${n}`);
      }
      return 0;
    }
    default:
      throw new Error(`unknown plugin action "${action}" (add|ls|rm|update)`);
  }
}
