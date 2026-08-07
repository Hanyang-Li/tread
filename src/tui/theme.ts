export const FG = {
  normal: "#d0d0d0",
  dim: "#8a8a8a",
  active: "#9BD692",
  warn: "#facc15",
  error: "#f87171",
  onSelect: "#101010",
} as const;

export const BG = {
  /** muted, not paper-white — it sits next to dim text all day */
  select: "#b8b8b8",
  none: undefined,
} as const;

/** light enough to read against a dark terminal background */
export const BORDER = "#9a9a9a";
