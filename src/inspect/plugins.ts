import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { agentDir } from "../paths.ts";
import type { PluginInfo } from "./types.ts";

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function claudePlugins(cfg: string): PluginInfo[] {
  const installed = readJson(path.join(cfg, "plugins/installed_plugins.json"));
  const markets = readJson(path.join(cfg, "plugins/known_marketplaces.json")) ?? {};
  const out: PluginInfo[] = [];
  for (const [key, list] of Object.entries<any>(installed?.plugins ?? {})) {
    const [name, marketplace = null] = key.split("@");
    for (const rec of Array.isArray(list) ? list : []) {
      // environment-level only; project-scoped installs belong to the project
      if (rec?.scope !== "user") continue;
      const manifest = readJson(
        path.join(rec.installPath ?? "", ".claude-plugin/plugin.json"),
      );
      const src = marketplace ? markets[marketplace]?.source : null;
      out.push({
        name,
        version: rec.version && rec.version !== "unknown" ? rec.version : null,
        description: manifest?.description ?? null,
        author: manifest?.author?.name ?? manifest?.author ?? null,
        marketplace,
        marketplaceSource: src?.repo ? `${src.source}:${src.repo}` : null,
        commit: rec.gitCommitSha ? String(rec.gitCommitSha).slice(0, 7) : null,
        installedAt: rec.installedAt ?? null,
        updatedAt: rec.lastUpdated ?? null,
        path: rec.installPath ?? null,
        enabled: true,
      });
    }
  }
  return out;
}

function kimiPlugins(cfg: string): PluginInfo[] {
  const data = readJson(path.join(cfg, "plugins/installed.json"));
  const list = Array.isArray(data?.plugins) ? data.plugins : [];
  return list.map((p: any) => ({
    name: p?.id ?? "?",
    version: p?.version ?? null,
    description: null,
    author: null,
    marketplace: null,
    marketplaceSource: p?.originalSource ?? p?.source ?? null,
    commit: p?.github?.installedSha ? String(p.github.installedSha).slice(0, 7) : null,
    installedAt: p?.installedAt ?? null,
    updatedAt: p?.updatedAt ?? null,
    path: p?.root ?? null,
    enabled: p?.enabled !== false,
  }));
}

function cursorPlugins(cfg: string): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const sub of ["plugins/local", "plugins/cache"]) {
    const base = path.join(cfg, sub);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      out.push({
        name: e.name,
        version: null,
        description: null,
        author: null,
        marketplace: sub.endsWith("cache") ? "cache" : "local",
        marketplaceSource: null,
        commit: null,
        installedAt: null,
        updatedAt: null,
        path: path.join(base, e.name),
        enabled: true,
      });
    }
  }
  return out;
}

export function readPlugins(envRoot: string, a: Agent): PluginInfo[] {
  const cfg = agentDir(envRoot, a);
  const out =
    a === "claude" ? claudePlugins(cfg)
    : a === "kimi" ? kimiPlugins(cfg)
    : cursorPlugins(cfg);
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
