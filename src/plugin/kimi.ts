import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { layout } from "../paths.ts";
import { requireEnv } from "../env.ts";
import { readJson, run, writeJson } from "./market.ts";

const DEFAULT_MARKETPLACE = "https://code.kimi.com/kimi-code/plugins/marketplace.json";

interface InstalledRecord {
  id: string;
  root: string;
  source: "local-path" | "zip-url" | "github";
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  github?: { owner: string; repo: string; ref: { kind: "branch" | "tag" | "sha"; value: string }; installedSha?: string };
}

interface InstalledFile {
  version: 1;
  plugins: InstalledRecord[];
}

function installedFile(envDir: string): string {
  return path.join(layout("kimi", envDir).pluginsDir, "installed.json");
}

function managedDir(envDir: string): string {
  return path.join(layout("kimi", envDir).pluginsDir, "managed");
}

function loadInstalled(envDir: string): InstalledFile {
  const j = readJson(installedFile(envDir));
  if (j && Array.isArray(j.plugins)) return { version: 1, plugins: j.plugins };
  return { version: 1, plugins: [] };
}

function saveInstalled(envDir: string, data: InstalledFile): void {
  // mirror kimi's atomic write: tmp + rename
  const file = installedFile(envDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function findManifest(dir: string): string | null {
  for (const f of ["kimi.plugin.json", ".kimi-plugin/plugin.json"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** If dir has no manifest but exactly one subdir does, use the subdir (github zip wrapper). */
function detectPluginRoot(dir: string): string {
  if (findManifest(dir)) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (subs.length === 1 && findManifest(path.join(dir, subs[0].name))) {
    return path.join(dir, subs[0].name);
  }
  throw new Error(`no kimi.plugin.json or .kimi-plugin/plugin.json found in ${dir}`);
}

function githubMeta(url: string): InstalledRecord["github"] | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: { kind: "branch", value: "main" } };
}

/** Resolve any plugin source to a local directory. Returns { root, cleanup, sourceKind }. */
async function fetchSource(source: string): Promise<{ root: string; cleanup: () => void; kind: InstalledRecord["source"] }> {
  // local path
  if (fs.existsSync(source)) {
    return { root: detectPluginRoot(path.resolve(source)), cleanup: () => {}, kind: "local-path" };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-kimi-plugin-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    if (/\.zip($|\?)/.test(source)) {
      const zip = path.join(tmp, "plugin.zip");
      const res = await fetch(source);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${source}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const r = await run(["unzip", "-q", zip, "-d", path.join(tmp, "x")]);
      if (r.code !== 0) throw new Error(`unzip failed: ${r.stderr}`);
      return { root: detectPluginRoot(path.join(tmp, "x")), cleanup, kind: "zip-url" };
    }
    // treat as git URL (github shorthand or full url)
    const url = /^[\w-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}` : source;
    const r = await run(["git", "clone", "--depth", "1", url, path.join(tmp, "repo")]);
    if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr}`);
    return { root: detectPluginRoot(path.join(tmp, "repo")), cleanup, kind: "github" };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function installFromDir(envDir: string, root: string, source: string, kind: InstalledRecord["source"]): InstalledRecord {
  const manifestPath = findManifest(root);
  if (!manifestPath) throw new Error(`no manifest in ${root}`);
  const manifest = readJson(manifestPath);
  if (!manifest?.name) throw new Error(`manifest ${manifestPath} has no "name"`);
  const id = String(manifest.name).toLowerCase();

  const managed = managedDir(envDir);
  fs.mkdirSync(managed, { recursive: true });
  const dest = path.join(managed, id);
  const staging = fs.mkdtempSync(path.join(managed, `${id}-`));
  fs.cpSync(root, staging, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);

  const data = loadInstalled(envDir);
  const now = new Date().toISOString();
  const existing = data.plugins.find((p) => p.id === id);
  const record: InstalledRecord = {
    id,
    root: fs.realpathSync(dest),
    source: kind,
    enabled: existing?.enabled ?? true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    originalSource: source,
  };
  if (kind === "github") {
    const gh = githubMeta(source);
    if (gh) record.github = gh;
  }
  data.plugins = [...data.plugins.filter((p) => p.id !== id), record];
  saveInstalled(envDir, data);
  return record;
}

/**
 * Kimi has no scriptable plugin CLI (TUI-only /plugins). tread writes the
 * same on-disk state kimi itself uses: plugins/managed/<id>/ + installed.json.
 */
export async function kimiPlugin(action: string, envName: string, args: string[]): Promise<number> {
  const dir = requireEnv("kimi", envName);

  switch (action) {
    case "add": {
      let [source, pluginId] = args;
      // marketplace mode: default URL, explicit marketplace.json URL, or no source at all
      const isMarketplace = !source || source === "official" || source.endsWith("marketplace.json");
      if (isMarketplace) {
        const url = !source || source === "official" ? DEFAULT_MARKETPLACE : source;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`marketplace fetch failed: HTTP ${res.status} ${url}`);
        const json: any = await res.json();
        const entries: any[] = Array.isArray(json?.plugins) ? json.plugins : [];
        if (entries.length === 0) throw new Error(`no plugins in ${url}`);
        if (!pluginId) {
          console.log(`plugins in ${url}:`);
          for (const e of entries) console.log(`  ${e.id}${e.description ? ` — ${e.description}` : ""}`);
          console.log(`\ninstall one with: tread plugin add kimi ${envName} official <id>`);
          return 0;
        }
        const entry = entries.find((e) => e.id === pluginId);
        if (!entry) throw new Error(`plugin "${pluginId}" not found in ${url}`);
        source = new URL(entry.source, url).toString();
      }
      if (!source) throw new Error("usage: tread plugin add kimi <env> <source|official> [plugin-id]");
      const { root, cleanup, kind } = await fetchSource(source);
      try {
        const rec = installFromDir(dir, root, source, kind);
        console.log(`installed ${rec.id} → ${rec.root}`);
        console.log(`restart the kimi session (or /reload) for it to take effect`);
      } finally {
        cleanup();
      }
      return 0;
    }
    case "ls": {
      const data = loadInstalled(dir);
      if (data.plugins.length === 0) {
        console.log("(no plugins)");
        return 0;
      }
      for (const p of data.plugins) {
        console.log(`${p.id}${p.enabled ? "" : " (disabled)"}  ${p.originalSource ?? p.source}`);
      }
      return 0;
    }
    case "rm": {
      const [id] = args;
      if (!id) throw new Error("usage: tread plugin rm kimi <env> <id>");
      const data = loadInstalled(dir);
      const before = data.plugins.length;
      data.plugins = data.plugins.filter((p) => p.id !== id);
      if (data.plugins.length === before) throw new Error(`plugin "${id}" not installed`);
      saveInstalled(dir, data);
      // match kimi's own behavior: only the record is removed, managed copy stays
      console.log(`removed ${id} (record only; managed copy kept, matching kimi behavior)`);
      return 0;
    }
    case "update": {
      const data = loadInstalled(dir);
      const targets = args.length ? data.plugins.filter((p) => args.includes(p.id)) : data.plugins;
      if (targets.length === 0) throw new Error(args.length ? `plugin(s) not installed: ${args.join(", ")}` : "(no plugins)");
      for (const p of targets) {
        if (!p.originalSource) {
          console.log(`skip ${p.id}: no recorded source`);
          continue;
        }
        const { root, cleanup, kind } = await fetchSource(p.originalSource);
        try {
          installFromDir(dir, root, p.originalSource, kind);
          console.log(`updated ${p.id}`);
        } finally {
          cleanup();
        }
      }
      return 0;
    }
    default:
      throw new Error(`unknown plugin action "${action}" (add|ls|rm|update)`);
  }
}
