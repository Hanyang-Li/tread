#!/usr/bin/env bun
import { runCommand } from "./commands.ts";

// `tread status | head` closes stdout early; that is a normal way to use a
// CLI, not a crash.
function quietEpipe(e: unknown): void {
  if ((e as NodeJS.ErrnoException)?.code === "EPIPE") process.exit(0);
  throw e;
}
process.stdout.on("error", quietEpipe);
process.stderr.on("error", () => {});

function writer(stream: NodeJS.WriteStream): (s: string) => void {
  return (s) => {
    try {
      stream.write(s);
    } catch (e) {
      quietEpipe(e);
    }
  };
}

process.exitCode = await runCommand(
  process.argv.slice(2),
  writer(process.stdout),
  writer(process.stderr),
);
