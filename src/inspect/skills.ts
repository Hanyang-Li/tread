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
    out.push({
      name: fm.name ?? e.name,
      version: fm.version ?? null,
      description: fm.description ?? null,
      source: l.source ?? null,
      sourceUrl: l.sourceUrl ?? null,
      path: dir,
      installedAt: l.installedAt ?? null,
      requiresBins: fm.requiresBins ?? [],
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
