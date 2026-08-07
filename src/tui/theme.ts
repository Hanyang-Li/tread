/**
 * One green and one red for the whole app, taken from Catppuccin Mocha, so
 * "this env is active" and "this server connected" read as the same signal.
 */
const GREEN = "#a6e3a1";
const RED = "#f38ba8";

export const FG = {
  normal: "#ffffff",
  dim: "#8a8a8a",
  active: GREEN,
  ok: GREEN,
  warn: "#facc15",
  error: RED,
  onSelect: "#101010",
} as const;

export const BG = {
  select: "#ffffff",
  none: undefined,
} as const;

/** light enough to read against a dark terminal background */
export const BORDER = "#9a9a9a";
