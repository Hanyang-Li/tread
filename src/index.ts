#!/usr/bin/env bun
import { runCommand } from "./commands.ts";

process.exitCode = await runCommand(process.argv.slice(2), (s) => process.stdout.write(s));
