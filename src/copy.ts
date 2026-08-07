import fs from "node:fs";
import path from "node:path";
import { AGENTS, AGENT_SPECS } from "./agents.ts";
import { ensureSkeleton, requireEnv } from "./env.ts";
import { envDir, envsDir, realHome, stateDir } from "./paths.ts";

/** Past this size a file is not worth scanning for a path to rewrite. */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

/**
 * Env-relative paths a copy leaves behind, beyond the per-agent lists.
 *
 * Exact paths, not names — see `AgentSpec.volatile` for why that distinction
 * decides whether the plugins survive.
 */
const SHARED_VOLATILE = [
  ".tread/sync.json", // regenerated for dst; src's copy is src's own ledger
  ".local/state", // tread's state dir, plus gh and claude lock files
  "Library/Caches", // cursor's compile cache
  "Library/Application Support", // cursor desktop's skill index db, clawhub state
];

export function volatilePaths(): string[] {
  const out = [...SHARED_VOLATILE];
  for (const a of AGENTS) {
    for (const rel of AGENT_SPECS[a].volatile) {
      out.push(`${AGENT_SPECS[a].dir}/${rel}`);
    }
  }
  return out;
}

export interface CopyResult {
  /** The new environment's root. */
  root: string;
  files: number;
  rewritten: number;
  /** env-relative paths left behind: odd file types, too deep, too big, unwritable */
  skipped: string[];
}

function under(p: string, base: string): boolean {
  return p === base || p.startsWith(base + path.sep);
}

/**
 * Whether a link is one `syncHomeLinks` put there to share the real home.
 *
 * The state dir has to be carved out: environments live under the real home
 * themselves, so "points into the real home" is also true of a link to the
 * environment's own sibling file — and plugin trees ship those (superpowers
 * has `AGENTS.md -> CLAUDE.md`). Without the exception those links were read
 * as home shares and dropped from the copy.
 */
function isHomeShare(target: string): boolean {
  return under(target, realHome()) && !under(target, stateDir());
}

/**
 * Copy an environment's own content, and only its own.
 *
 * Links into the real home are left out entirely: `ensureSkeleton` puts them
 * back from dst's configuration, which is the current answer to what is
 * shared, while src's links are a snapshot of whatever the config said the day
 * src was built. Every other link is recreated pointing at dst's own copy —
 * see `retarget`.
 *
 * Bytes go into `into`, a staging directory, while links are written against
 * `dst`, where the staging directory is about to be renamed: a link pointing
 * into `.cp-dst.1234` would dangle the moment the copy succeeded.
 */
function copyTree(src: string, into: string, dst: string, result: CopyResult): void {
  const volatile = new Set(volatilePaths());

  const copyFile = (from: string, to: string): void => {
    fs.copyFileSync(from, to);
    // explicit, rather than trusting copyFileSync to carry the mode: hooks and
    // skill installers are executable files, and losing +x fails at run time
    fs.chmodSync(to, fs.statSync(from).mode & 0o7777);
    result.files++;
  };

  /**
   * What a recreated link should point at.
   *
   * A relative link is kept verbatim: it already resolves inside the copy, and
   * because dst is always a sibling of src under `<envs>/`, even one that
   * climbs out lands in the same place it did before. An absolute link into src
   * is repointed at dst, which is the whole difference between a copy and a
   * second name for the source. Anything else — a link to /opt, say — is
   * carried over as it was: src pointed there too, and that is not a tie
   * between the two environments.
   */
  const retarget = (raw: string, target: string): string => {
    if (!path.isAbsolute(raw)) return raw;
    if (under(target, src)) return path.join(dst, path.relative(src, target));
    return raw;
  };

  const walk = (rel: string): void => {
    const dir = rel ? path.join(src, rel) : src;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (volatile.has(childRel)) continue;
      const from = path.join(src, childRel);
      const to = path.join(into, childRel);

      if (entry.isSymbolicLink()) {
        const raw = fs.readlinkSync(from);
        const target = path.resolve(path.dirname(from), raw);
        if (isHomeShare(target)) continue; // ensureSkeleton rebuilds these
        fs.symlinkSync(retarget(raw, target), to);
        continue;
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(childRel);
        continue;
      }
      if (entry.isFile()) {
        copyFile(from, to);
        continue;
      }
      result.skipped.push(childRel); // socket, fifo, device node
    }
  };

  walk("");
}

/**
 * Replace every mention of `from` with `to` in the files under `root`.
 *
 * A byte-identical copy is not an independent environment. Agents bake their
 * absolute config path into what they write: claude's hook commands and
 * installed_plugins.json, cursor's hooks.json, kimi's extra_skill_dirs, and
 * whatever path a skill's own installer computed. Left alone, the copy reads
 * the source's directories and says nothing about it — you edit a hook here
 * and watch the old one keep running.
 *
 * Literal, whole-path substitution only. The environment *name* is never
 * substituted: a name like "test" would hit prose everywhere.
 */
export function rewritePaths(
  root: string,
  from: string,
  to: string,
): { rewritten: number; skipped: string[] } {
  let rewritten = 0;
  const skipped: string[] = [];

  const walk = (rel: string): void => {
    const dir = rel ? path.join(root, rel) : root;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const p = path.join(root, childRel);
      // never follow a link: those point into the real home, which is not ours
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.size > MAX_REWRITE_BYTES) {
        skipped.push(childRel);
        continue;
      }
      const buf = fs.readFileSync(p);
      // a NUL early on means binary: substituting into it would corrupt the
      // file, and no agent writes its configuration that way
      if (buf.subarray(0, 8192).includes(0)) continue;
      const text = buf.toString("utf8");
      if (!text.includes(from)) continue;
      try {
        fs.writeFileSync(p, text.split(from).join(to));
        rewritten++;
      } catch {
        // an unwritable file is worth reporting, not worth failing the copy
        skipped.push(childRel);
      }
    }
  };

  walk("");
  return { rewritten, skipped };
}

/**
 * `tread cp <src> <dst>` — duplicate an environment, leaving the two unrelated.
 */
export function copyEnv(srcName: string, dstName: string): CopyResult {
  const src = requireEnv(srcName);
  const dst = envDir(dstName); // validates the name
  if (fs.existsSync(dst)) {
    throw new Error(
      `"${dstName}" already exists\n\n  ${dst}\n  tread rm ${dstName}   to replace it`,
    );
  }

  // land in a staging directory and rename: the byte copy is the long, failure
  // prone part, and half an environment is worse than none — it shows up in
  // `tread ls` and its status table looks perfectly plausible
  const staging = path.join(envsDir(), `.cp-${dstName}.${process.pid}`);
  const result: CopyResult = { root: dst, files: 0, rewritten: 0, skipped: [] };
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    copyTree(src, staging, dst, result);
    fs.renameSync(staging, dst);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  // after the rename, so the links and the generated tread skill are written
  // against the final path rather than the staging one
  ensureSkeleton(dst);
  const rw = rewritePaths(dst, src, dst);
  result.rewritten = rw.rewritten;
  result.skipped.push(...rw.skipped);
  return result;
}
