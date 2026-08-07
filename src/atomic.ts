import fs from "node:fs";
import path from "node:path";

let counter = 0;

/**
 * Replace a file in one step.
 *
 * `writeFileSync` truncates before it writes, so a concurrent reader can see
 * an empty or half-written file, and a crash can leave one behind. Writing a
 * sibling and renaming over the target closes both windows: rename is atomic
 * within a filesystem, so a reader sees either the whole old file or the whole
 * new one. The temp name carries the pid because two processes writing the
 * same target must not collide on the temp file either.
 */
export function writeFileAtomic(file: string, text: string, mode?: number): void {
  const tmp = `${file}.${process.pid}.${counter++}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? {} : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}
