const ANSI_RE = /\x1b\[[0-9;]*m/g;

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** Column width as the terminal sees it: CJK and emoji occupy two cells. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)));
}

function padLeft(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - displayWidth(s))) + s;
}

export type Align = "left" | "right";

/**
 * Align rows into columns. A left-aligned last cell is not padded, so lines
 * carry no trailing whitespace; a right-aligned one still is, since its
 * padding is what does the aligning.
 */
export function table(
  rows: string[][],
  opts: { gap?: number; align?: Align[] } = {},
): string[] {
  const gap = opts.gap ?? 2;
  const align = opts.align ?? [];
  const cols = rows.length ? Math.max(...rows.map((r) => r.length)) : 0;
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) {
    widths[i] = Math.max(0, ...rows.map((r) => displayWidth(r[i] ?? "")));
  }
  return rows.map((r) =>
    r
      .map((cell, i) => {
        const right = align[i] === "right";
        const last = i === r.length - 1;
        if (right) return padLeft(cell, widths[i]) + (last ? "" : " ".repeat(gap));
        return last ? cell : pad(cell, widths[i] + gap);
      })
      .join("")
      // an empty trailing cell would otherwise leave the gap dangling
      .replace(/\s+$/, ""),
  );
}

/** Elide the middle, keeping the tail — for paths the tail carries the meaning. */
export function truncateMiddle(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  if (max <= 1) return "…";
  const keepTail = Math.floor((max - 1) * 0.6);
  const keepHead = max - 1 - keepTail;
  const chars = [...s];
  let head = "";
  let tail = "";
  for (const ch of chars) {
    if (displayWidth(head + ch) > keepHead) break;
    head += ch;
  }
  for (let i = chars.length - 1; i >= 0; i--) {
    if (displayWidth(chars[i] + tail) > keepTail) break;
    tail = chars[i] + tail;
  }
  return head + "…" + tail;
}

export function relTime(iso: string | null, now = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const s = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const id = (s: string) => s;

export interface Palette {
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  bold: (s: string) => string;
  inverse: (s: string) => string;
}

export function color(on: boolean): Palette {
  return on
    ? {
        dim: wrap("2"),
        red: wrap("31"),
        green: wrap("32"),
        yellow: wrap("33"),
        bold: wrap("1"),
        inverse: wrap("7"),
      }
    : { dim: id, red: id, green: id, yellow: id, bold: id, inverse: id };
}

export function colorsEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/** Shorten an absolute path under $HOME to ~/… form. */
export function tildify(p: string, home = process.env.HOME ?? ""): string {
  return home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

export function formatError(message: string): string {
  return `tread: ${message}`;
}
