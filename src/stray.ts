import fs from "node:fs";
import path from "node:path";
import { replaceSymlinkAtomic } from "./atomic.ts";
import { defaultAllow } from "./config.ts";
import { listEnvs, sharedPaths } from "./env.ts";
import { envDir, envsDir, isUnder, realHome } from "./paths.ts";

/**
 * A symlink in the real home that points into an environment.
 *
 * The mirror image of `leak.ts`: that one is about the real home reaching into
 * an agent, this one is about an agent reaching back out.
 *
 * It happens because sharing is implemented as a symlink to the whole
 * directory — `<env>/.local/bin` *is* `~/.local/bin` — so a write inside the
 * environment lands on the user's own file. That much is intended, and for
 * ordinary content it is harmless. What is not harmless is a tool that writes
 * an absolute path derived from `$HOME`, because the shims have moved `$HOME`
 * to the environment root: claude's native updater rebuilds its launcher as
 * `$HOME/.local/bin/claude -> $HOME/.local/share/claude/versions/<v>`, both
 * halves resolve through the shared link, and what ends up in the real home is
 * a symlink whose target names an environment. Nothing looks wrong until that
 * environment is deleted, at which point `claude` is gone from the real home
 * too — the binary is still there, only the launcher points at a path that no
 * longer exists.
 *
 * So the invariant is: nothing in the real home may point into *any*
 * environment. Not "into the one being deleted" — checking the general form is
 * what lets `use` clean up after the previous session, instead of the damage
 * sitting there until somebody happens to run `rm`.
 */
export interface StrayLink {
  /** absolute path of the offending link, in the real home */
  link: string;
  /** where it points, resolved against the link's own directory */
  target: string;
  /** the environment the target falls inside */
  env: string;
  /** where it should point instead, or null when that cannot be inferred safely */
  repair: string | null;
  /** whether the target resolves at all right now */
  dangling: boolean;
}

export interface StrayScan {
  found: StrayLink[];
  /**
   * A budget cut the walk short, so an empty `found` is not a clean bill of
   * health. Reported rather than swallowed: a check that quietly gives up and
   * says "fine" is worse than one that admits it did not look everywhere.
   */
  truncated: boolean;
}

export interface StrayHeal {
  repaired: StrayLink[];
  /** found, but left alone — `repair` was null, or the write failed */
  stuck: StrayLink[];
  truncated: boolean;
}

/**
 * How far below a shared root to look, and how much of the walk to pay for.
 *
 * Every case seen in the wild sits one level down (`~/.local/bin/claude`), but
 * a tool keeping its launcher in a subdirectory of `.local/share` would sit
 * three, so the depth is three and the cost is bounded by the budgets instead.
 * They are deliberately small: this runs on `tread use`, which has to stay
 * imperceptible, and giving up early is acceptable because `truncated` says so.
 *
 * Overridable so the tests can drive the give-up paths without building a
 * directory tree big enough to exhaust the real numbers.
 */
export interface StrayLimits {
  maxDepth?: number;
  direntBudget?: number;
  timeBudgetMs?: number;
}

const MAX_DEPTH = 3;
const DIRENT_BUDGET = 20_000;
const TIME_BUDGET_MS = 120;

interface Ctx {
  home: string;
  envs: string;
  /** home-relative paths each environment shares, by environment name */
  sharedByEnv: Map<string, string[]>;
  /** every path any environment could plausibly share, for the ones now gone */
  anyShared: string[];
}

/** Whether `rel` is one of `roots` or sits below one. */
function underAny(rel: string, roots: string[]): boolean {
  return roots.some((r) => rel === r || rel.startsWith(r + "/"));
}

/** Whether `link` points into an environment, and what to do about it. */
function classify(link: string, ctx: Ctx): StrayLink | null {
  let raw: string;
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    raw = fs.readlinkSync(link);
  } catch {
    return null;
  }
  // a relative target is resolved against the link's directory, not the cwd
  const target = path.resolve(path.dirname(link), raw);
  if (!isUnder(target, ctx.envs)) return null;

  const parts = path.relative(ctx.envs, target).split(path.sep);
  const env = parts[0]!;
  const rel = parts.slice(1).join("/");

  // The repair maps the environment prefix back to the real home, which is
  // sound for the same reason the damage happened: the write went through a
  // shared link, so the file it created is already sitting at the
  // corresponding place in the real home.
  //
  // That reasoning only holds where the path really is shared, so the mapping
  // is refused otherwise rather than guessed. It rules out two things: a link
  // to the environment root itself, which is somebody's own shortcut and not a
  // tool's launcher, and a link into an isolated directory like `<env>/.claude`
  // — no write inside the environment could have produced that one out here,
  // so whatever it is, tread did not cause it and should not redirect it.
  const roots = ctx.sharedByEnv.get(env) ?? ctx.anyShared;
  const candidate = rel && underAny(rel, roots) ? path.join(ctx.home, rel) : null;
  const repair = candidate && fs.existsSync(candidate) ? candidate : null;
  return { link, target, env, repair, dangling: !fs.existsSync(link) };
}

function scan(limits: StrayLimits): StrayScan {
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const deadline = Date.now() + (limits.timeBudgetMs ?? TIME_BUDGET_MS);
  let budget = limits.direntBudget ?? DIRENT_BUDGET;

  const home = realHome();
  const sharedByEnv = new Map<string, string[]>();
  for (const name of listEnvs()) sharedByEnv.set(name, sharedPaths(envDir(name)));

  // The defaults are in the union as well as the live environments' manifests,
  // because the walk has to start somewhere even when the environment that
  // caused the damage is already gone — which, for a link that dangles, it
  // usually is. Without them, deleting the last environment would take the
  // starting points away along with it and the check would go quiet exactly
  // when there is something to find.
  const anyShared = new Set<string>(defaultAllow());
  for (const list of sharedByEnv.values()) for (const p of list) anyShared.add(p);

  const ctx: Ctx = { home, envs: envsDir(), sharedByEnv, anyShared: [...anyShared] };
  const found: StrayLink[] = [];
  let truncated = false;

  // Only a shared path can hold one of these — a write inside the environment
  // reaches the real home through a share or not at all — so they bound the
  // walk. Scanning the whole home would be both slower and wider than the
  // damage it is looking for.
  const queue: { dir: string; depth: number }[] = [];
  const seen = new Set<string>();
  for (const rel of ctx.anyShared) {
    const p = path.join(home, rel);
    if (seen.has(p)) continue;
    seen.add(p);
    const stray = classify(p, ctx);
    if (stray) found.push(stray);
    else queue.push({ dir: p, depth: 0 });
  }

  // Breadth first, and that is not incidental. The real cases all sit at depth
  // one, and a depth-first walk can spend the entire budget inside `.cache`
  // before it ever reaches `~/.local/bin`. This way running out costs the
  // deepest entries, which are the least likely to matter.
  while (queue.length > 0) {
    if (budget <= 0 || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (--budget <= 0) {
        truncated = true;
        break;
      }
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const stray = classify(p, ctx);
        if (stray) found.push(stray);
        // never descend through a link: following one is how a walk finds a
        // cycle, and a shared tree is full of links back to the real home
        continue;
      }
      if (e.isDirectory() && depth + 1 < maxDepth && !seen.has(p)) {
        seen.add(p);
        queue.push({ dir: p, depth: depth + 1 });
      }
    }
  }
  return { found, truncated };
}

/**
 * Every symlink in the real home that points into an environment.
 *
 * Never throws. This runs on the way into `tread use` and on the way into
 * `rm`, and a health check that can block either of them is a worse bug than
 * the one it exists to catch. A failure reports as "looked at nothing", which
 * is what `truncated` already means.
 */
export function findStrayLinks(limits: StrayLimits = {}): StrayScan {
  try {
    return scan(limits);
  } catch {
    return { found: [], truncated: true };
  }
}

/** Repoint one link at the real home. False when it could not be done. */
export function repairStrayLink(s: StrayLink): boolean {
  if (!s.repair) return false;
  try {
    replaceSymlinkAtomic(s.repair, s.link);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find and repair in one go, for the callers that fix rather than report.
 *
 * No lock. The repair is idempotent and the write is atomic, so two shells
 * doing this at the same moment arrive at the same place — while a lock would
 * put activations behind each other for a check that usually finds nothing.
 */
export function healStrayLinks(limits: StrayLimits = {}): StrayHeal {
  const { found, truncated } = findStrayLinks(limits);
  const repaired: StrayLink[] = [];
  const stuck: StrayLink[] = [];
  for (const s of found) {
    if (repairStrayLink(s)) repaired.push(s);
    else stuck.push(s);
  }
  return { repaired, stuck, truncated };
}
