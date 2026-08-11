import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

/**
 * Signals that end a TUI, with the exit code each one conventionally reports.
 *
 * opentui listens for these itself and its handler only tears the renderer
 * down. Registering a listener replaces the default disposition, so the
 * terminate that SIGHUP used to imply is gone and nothing puts it back.
 */
const SIGNALS = [["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15]] as const;

/**
 * Mount a TUI on the alternate screen and resolve once it asks to exit.
 *
 * Ctrl+C and the signals above are torn down by opentui rather than by us, and
 * neither path ends the process. Both are covered here, because a TUI that
 * survives its own terminal is not merely still running: it is orphaned, it
 * cannot be reached, and its event loop spins a core on a screen nobody can
 * see, for as long as the machine is up.
 */
export async function mount(
  render: (exit: (code?: number) => void) => ReactNode,
): Promise<number> {
  // reassigned below, before a frame is drawn and so before onDestroy can fire
  let exit: (code?: number) => void = () => {};
  // onDestroy is the one hook that observes every teardown opentui starts on
  // its own; Ctrl+C in raw mode is a keypress, never a signal, so it arrives
  // here and nowhere else
  const renderer = await createCliRenderer({ onDestroy: () => exit(130) });
  const root = createRoot(renderer);
  return await new Promise<number>((resolve) => {
    let done = false;
    const offSignals: Array<() => void> = [];
    exit = (code = 0) => {
      if (done) return;
      done = true;
      for (const off of offSignals) off();
      try {
        root.unmount();
      } catch {}
      try {
        renderer.destroy();
      } catch {}
      resolve(code);
    };
    for (const [sig, n] of SIGNALS) {
      const onSignal = () => {
        exit(128 + n);
        // the loop can still hold work that will never run now that the
        // renderer is gone, and a signal asks to be gone now, not eventually
        process.exit(128 + n);
      };
      process.on(sig, onSignal);
      offSignals.push(() => process.removeListener(sig, onSignal));
    }
    root.render(render(exit));
  });
}
