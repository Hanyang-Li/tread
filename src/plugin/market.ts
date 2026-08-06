import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { shareDir } from "../paths.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn and capture output. */
export async function run(cmd: string[], opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    env: opts.env ?? (process.env as Record<string, string | undefined>),
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Spawn inheriting stdio (interactive passthrough). Returns exit code. */
export async function runPassthrough(cmd: string[], opts: { env?: Record<string, string | undefined> } = {}): Promise<number> {
  const proc = Bun.spawn(cmd, {
    env: opts.env ?? (process.env as Record<string, string | undefined>),
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}

export function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function copyDir(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

/** Cache a marketplace git repo under the share dir; clone or fast-forward. */
export async function cacheMarketplace(url: string): Promise<string> {
  const key = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
  const dir = path.join(shareDir(), "marketplaces", key);
  if (fs.existsSync(path.join(dir, ".git"))) {
    const r = await run(["git", "-C", dir, "pull", "--ff-only"]);
    if (r.code !== 0) throw new Error(`git pull failed for ${url}: ${r.stderr}`);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = await run(["git", "clone", "--depth", "1", url, dir]);
    if (r.code !== 0) throw new Error(`git clone failed for ${url}: ${r.stderr}`);
  }
  return dir;
}

/**
 * Tolerantly extract a plugin list from a marketplace.json.
 * Handles { plugins: [...] } and bare [...] shapes.
 */
export function marketplaceEntries(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.plugins)) return json.plugins;
  return [];
}
