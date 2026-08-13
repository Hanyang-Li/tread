import fs from "node:fs";
import path from "node:path";
import { isUnder, realHome } from "./paths.ts";

/**
 * Real-home configuration that claude loads even from inside an environment.
 *
 * claude finds project-scope customization by walking up from the working
 * directory, collecting `<ancestor>/.claude/{skills,agents,commands}` on the
 * way. That walk stops at a `.git` or at `$HOME`. Since the shims point HOME
 * at the env root, the user's real home is no longer a boundary: from a
 * working directory below it with no repository in between, the walk climbs
 * straight past and picks the real `~/.claude` up as a *project* directory.
 * The env's own config dir is still isolated — these arrive alongside it.
 *
 * A second family runs on its own walk: memory files, `.mcp.json`, and
 * cursor's instructions and rules go all the way to `/`, include `$HOME`
 * itself, and ignore `.git` entirely (verified against a real repository, not
 * just a marker directory). A repository bounds the first family and never
 * this one, which leaks with or without the HOME redirection — not something
 * the environment can close.
 */
export type LeakScope = "all" | "memory";

export interface HomeLeak {
  /** "all" when nothing bounds the walk, "memory" when only the unbounded family gets through */
  scope: LeakScope;
  cwd: string;
  home: string;
  /** the directory whose `.git` bounds the project walk, when one is in reach */
  boundary: string | null;
  /** home-relative paths that actually hold something, so the warning names real files */
  surfaces: string[];
}

/** claude's project directories, all three cut off by a `.git`. */
const BOUNDED_SURFACES = [".claude/skills", ".claude/agents", ".claude/commands"];

/**
 * Surfaces that reach the agent whether or not a repository is in the way:
 * claude's memory files and `.mcp.json`, cursor's instructions and rules.
 *
 * Every entry here was confirmed to come through from an ancestor directory,
 * and these tested clean and are deliberately absent: claude's project
 * `settings.json`, claude's `AGENTS.md` (cursor does read it), cursor's
 * `skills`, and everything kimi discovers.
 */
const UNBOUNDED_SURFACES = [
  ".claude/CLAUDE.md", "CLAUDE.md", ".mcp.json", "AGENTS.md", ".cursor/rules",
];

function present(home: string, rel: string): boolean {
  const p = path.join(home, rel);
  try {
    const st = fs.statSync(p);
    // an empty directory contributes nothing, and warning about it would send
    // someone looking for a leak that is not there
    return st.isDirectory() ? fs.readdirSync(p).length > 0 : st.size > 0;
  } catch {
    return false;
  }
}

/**
 * The nearest ancestor of `cwd` — strictly below `home` — holding a `.git`.
 *
 * Stops below home deliberately: a `.git` in the home directory itself would
 * make home the repository root, and the root's own `.claude` is included
 * rather than cut off, so it bounds nothing that matters here.
 */
function gitBoundary(cwd: string, home: string): string | null {
  let dir = cwd;
  while (dir !== home && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * What the real home would bleed into an agent started in `cwd`, or null when
 * it would bleed nothing.
 *
 * Independent of which environment is active, and of whether one is: the
 * working directory and the real home decide it on their own.
 */
export function homeLeak(cwd: string = process.cwd(), home: string = realHome()): HomeLeak | null {
  const c = path.resolve(cwd);
  const h = path.resolve(home);
  // home is not an ancestor, so nothing of it is on the walk
  if (c !== h && !isUnder(c, h)) return null;
  // in home itself there is nothing to bound: the walk starts on the leak
  const boundary = c === h ? null : gitBoundary(c, h);
  const scope: LeakScope = boundary ? "memory" : "all";
  const candidates = scope === "memory"
    ? UNBOUNDED_SURFACES
    : [...BOUNDED_SURFACES, ...UNBOUNDED_SURFACES];
  const surfaces = candidates.filter((rel) => present(h, rel));
  if (surfaces.length === 0) return null;
  return { scope, cwd: c, home: h, boundary, surfaces };
}
