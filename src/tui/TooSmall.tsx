import { BORDER, FG } from "./theme.ts";
import { MIN_HEIGHT, MIN_WIDTH } from "./layout.ts";

/**
 * Shown instead of the real UI when the terminal cannot hold it. Never blank,
 * never garbled: below the panel's own size we drop the frame and clip.
 */
export function TooSmall({ width, height }: { width: number; height: number }) {
  if (width < 24 || height < 8) {
    return (
      <box flexDirection="column">
        <text fg={FG.warn}>too small</text>
        {height >= 2 ? <text fg={FG.dim}>{`${MIN_WIDTH}x${MIN_HEIGHT} needed`}</text> : null}
        {height >= 3 ? <text fg={FG.dim}>q to quit</text> : null}
      </box>
    );
  }
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={BORDER}
      padding={1}
      alignItems="center"
    >
      <text fg={FG.warn}>terminal too small</text>
      <text> </text>
      <text fg={FG.dim}>{`need   ${MIN_WIDTH} x ${MIN_HEIGHT}`}</text>
      <text fg={FG.dim}>{`have   ${width} x ${height}`}</text>
      <text> </text>
      <text fg={FG.dim}>resize, or q to quit</text>
    </box>
  );
}
