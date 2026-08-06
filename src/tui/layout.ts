export const MIN_WIDTH = 30;
export const MIN_HEIGHT = 8;

export type LayoutMode = "full" | "wide" | "narrow" | "minimal" | "plain";

export interface Layout {
  mode: LayoutMode;
  /** how many table columns fit */
  columns: number;
  /** whether section bodies / detail panes fit vertically */
  showDetail: boolean;
}

export function pickLayout(w: number, h: number): Layout {
  if (w < MIN_WIDTH || h < MIN_HEIGHT) {
    return { mode: "plain", columns: 1, showDetail: false };
  }
  const mode: LayoutMode =
    w >= 76 ? "full" : w >= 60 ? "wide" : w >= 44 ? "narrow" : "minimal";
  const columns = mode === "full" || mode === "wide" ? 3 : mode === "narrow" ? 2 : 1;
  return { mode, columns, showDetail: h >= 12 };
}

/** Keep the cursor inside a scrolling window of `size` rows. */
export function scrollWindow(
  index: number,
  total: number,
  size: number,
): { start: number; end: number } {
  if (size >= total) return { start: 0, end: total };
  const half = Math.floor(size / 2);
  let start = Math.max(0, Math.min(index - half, total - size));
  return { start, end: start + size };
}
