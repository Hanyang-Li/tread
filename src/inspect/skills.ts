import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agents.ts";
import { skillsDir } from "../paths.ts";
import type { SkillInfo } from "./types.ts";

interface LockEntry {
  source?: string;
  sourceType?: string;
  sourceUrl?: string;
  installedAt?: string;
}

function readLock(envRoot: string): Record<string, LockEntry> {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(envRoot, ".agents/.skill-lock.json"), "utf8"),
    );
    return j?.skills ?? {};
  } catch {
    return {};
  }
}

interface ClawhubOrigin {
  registry?: string;
  installedVersion?: string;
  installedAt?: number;
}

/**
 * clawhub drops its provenance inside the skill folder rather than in a
 * central lock, so it travels with the folder and is the only origin record
 * a clawhub-installed skill has.
 */
function readClawhubOrigin(dir: string): ClawhubOrigin | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".clawhub/origin.json"), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** Registry URL down to the host, to sit in the same column as "open.feishu.cn". */
function registryHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return url;
  }
}

function isoOf(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Minimal YAML frontmatter reader: top-level scalars plus the one nested
 * list we care about (metadata.requires.bins). Deliberately not a full YAML
 * parser — we only ever read, and unknown shapes degrade to null.
 */
export function parseFrontmatter(text: string): Record<string, any> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const body = text.slice(text.indexOf("\n") + 1, end);
  const out: Record<string, any> = {};
  let inRequires = false;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const bins = line.match(/^\s+bins:\s*\[(.*)\]\s*$/);
    if (inRequires && bins) {
      out.requiresBins = bins[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
    if (/^\s+requires:\s*$/.test(line)) {
      inRequires = true;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    inRequires = false;
    const [, k, v] = kv;
    if (v === "") continue;
    out[k] = v.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function readSkills(envRoot: string, a: Agent): SkillInfo[] {
  const base = skillsDir(envRoot, a);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const lock = readLock(envRoot);
  const out: SkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = path.join(base, e.name);
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    const l = lock[e.name] ?? {};
    const ch = readClawhubOrigin(dir);
    out.push({
      name: fm.name ?? e.name,
      version: fm.version ?? ch?.installedVersion ?? null,
      description: fm.description ?? null,
      source: l.source ?? registryHost(ch?.registry),
      sourceUrl: l.sourceUrl ?? null,
      registry: ch?.registry ?? null,
      path: dir,
      installedAt: l.installedAt ?? isoOf(ch?.installedAt),
      requiresBins: fm.requiresBins ?? [],
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
