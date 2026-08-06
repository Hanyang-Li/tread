import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

/** Mount a TUI on the alternate screen and resolve once it asks to exit. */
export async function mount(
  render: (exit: (code?: number) => void) => ReactNode,
): Promise<number> {
  const renderer = await createCliRenderer();
  const root = createRoot(renderer);
  return await new Promise<number>((resolve) => {
    let done = false;
    const exit = (code = 0) => {
      if (done) return;
      done = true;
      try {
        root.unmount();
      } catch {}
      try {
        renderer.destroy();
      } catch {}
      resolve(code);
    };
    root.render(render(exit));
  });
}
