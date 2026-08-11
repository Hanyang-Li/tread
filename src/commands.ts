import fs from "node:fs";
import path from "node:path";
import { AGENTS, AGENT_SPECS, isAgent, shimNames, type Agent } from "./agents.ts";
import {
  createEnv, ensureSkeleton, lastUsed, listEnvs, removeEnv, requireEnv, resolveEnv,
  syncHomeLinks,
} from "./env.ts";
import {
  activationEnv, agentDir, completionFile, envDir, realHome, shimsDir, skillsDir, stateDir,
  syncLockFile,
} from "./paths.ts";
import { clearStale, staleLock } from "./lock.ts";
import { loginIssues, sharedLogin } from "./login.ts";
import { homeLeak } from "./leak.ts";
import { copyEnv } from "./copy.ts";
import { complete, completionState, writeCompletion } from "./completion.ts";
import { realBinary, shimsHealthy, writeShims } from "./shims.ts";
import { deactivateLines, exportLines, initSnippet, shellLoaded, writeInit } from "./shell.ts";
import { colorsEnabled, color, formatError, table, tildify, type Palette } from "./render.ts";
import { VERSION } from "./version.ts";
import {
  hooksList, isCategory, lsPlain, mcpDetail, mcpList, pluginDetail, pluginsList,
  showPlain, skillDetail, skillsList, splitTargets, statusAll, statusOne, hookDetail,
} from "./views.ts";

type Out = (s: string) => void;

export const HELP = `tread — isolated environments for AI coding agents

usage: tread <command> [args]

  init <zsh|bash|fish|starship>   print shell integration
  create <name>                   create an environment
  cp <src> <dst>                  copy an environment
  use <name>                      activate it in this shell
  deactivate                      leave the active environment
  ls                              browse and switch environments
  status [env]                    what each environment holds
  show [env]                      browse one environment

  skills  [env] [agent] [name]    list or inspect (read-only)
  plugins [env] [agent] [name]
  mcp     [env] [agent] [name] [--probe]
  hooks   [env] [agent] [event]

  path [env] [agent] [category]   print a directory
  exec <env> [--home] -- <cmd>    run a command in an environment
  rm <name> [--force]             delete an environment
  doctor [env] [--fix]            check the setup, or just one environment

tread does not install skills, plugins, MCP servers or hooks — activate an
environment and use each agent's own tooling. It only shows you what is there.

what an environment shares with your real home is an allow list. to change it:
  ~/.config/tread/config.yaml        every environment
  <env>/.tread/config.yaml           one environment
`;

function takeFlag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

function takeOption(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, v === null ? 1 : 2);
  return v;
}

function activeName(): string | null {
  return process.env.TREAD_ENV ?? null;
}

/** Resolve `[env] [agent] [name]`, defaulting env to the active one. */
function targets(args: string[]): { root: string; name: string; agent: Agent | null; item: string | null } {
  const { envName, agent, name } = splitTargets(args);
  const root = resolveEnv(envName ?? undefined);
  return { root, name: envName ?? activeName()!, agent, item: name };
}

function eachAgent(agent: Agent | null): readonly Agent[] {
  return agent ? [agent] : AGENTS;
}

async function categoryCommand(
  cat: string,
  args: string[],
  out: Out,
): Promise<number> {
  const probe = takeFlag(args, "--probe");
  const { root, agent, item } = targets(args);
  const c = color(colorsEnabled());

  if (item) {
    const a = agent ?? "claude";
    switch (cat) {
      case "skills": out(skillDetail(root, a, item)); break;
      case "plugins": out(pluginDetail(root, a, item)); break;
      case "mcp": out(await mcpDetail(root, a, item, probe)); break;
      case "hooks": out(hookDetail(root, a, item)); break;
    }
    return 0;
  }

  const agents = eachAgent(agent);
  const parts: string[] = [];
  for (const a of agents) {
    const body =
      cat === "skills" ? skillsList(root, a)
      : cat === "plugins" ? pluginsList(root, a)
      : cat === "mcp" ? await mcpList(root, a, probe)
      : hooksList(root, a);
    parts.push(agents.length > 1 ? `${c.bold(a)}\n${body}` : body);
  }
  out(parts.join("\n"));
  return 0;
}

async function execCommand(args: string[], out: Out): Promise<number> {
  const sep = args.indexOf("--");
  if (sep === -1) {
    throw new Error(
      "exec needs -- before the command\n\n  tread exec work -- claude -p \"hi\"",
    );
  }
  const head = args.slice(0, sep);
  const cmd = args.slice(sep + 1);
  const withHome = takeFlag(head, "--home");
  const name = head[0];
  if (!name) throw new Error("exec needs an environment\n\n  tread exec <env> -- <cmd>");
  if (cmd.length === 0) throw new Error("exec needs a command after --");
  const root = requireEnv(name);
  ensureSkeleton(root);

  const env: Record<string, string | undefined> = { ...process.env, ...activationEnv(root), TREAD_ENV: name };
  // only tools that resolve paths through $HOME need this; changing it
  // unconditionally would break git, ssh and npm inside the command
  if (withHome) env.HOME = root;

  try {
    const proc = Bun.spawn(cmd, { env, stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  } catch {
    throw new Error(`cannot run "${cmd[0]}": not found on PATH\n\n  tread doctor   to check all agent CLIs`);
  }
}

function createCommand(args: string[], out: Out): number {
  const name = args[0];
  if (!name) throw new Error("create needs a name\n\n  tread create <name>");
  out(`created  ${tildify(createEnv(name))}\n`);
  return 0;
}

function cpCommand(args: string[], out: Out): number {
  const [src, dst] = args;
  // both names are always explicit. `cp` takes two arguments everywhere else,
  // and a one-argument form would read as the source or the target depending
  // on whether an environment happens to be active
  if (!src || !dst) throw new Error("cp needs two names\n\n  tread cp <src> <dst>");
  const c = color(colorsEnabled());
  const r = copyEnv(src, dst);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const notes = ["skipped sessions and caches", `${plural(r.rewritten, "path")} rewritten`];
  if (r.skipped.length > 0) notes.push(`${plural(r.skipped.length, "file")} skipped`);

  out(`copied  ${c.bold(src)} → ${c.brightGreen(dst)}\n\n`);
  // the same renderer `tread status` uses, so the two can never disagree
  out(statusOne(r.root, dst, false));
  // the one place the copy admits it was not byte for byte
  out(c.dim(notes.join(" · ")) + "\n");
  return 0;
}

function rmCommand(args: string[], out: Out): number {
  const force = takeFlag(args, "--force", "-f");
  const name = args[0];
  if (!name) throw new Error("rm needs a name\n\n  tread rm <name>");
  const root = requireEnv(name);
  if (activeName() === name) {
    throw new Error(`"${name}" is currently active\n\n  tread deactivate   then try again`);
  }
  if (!force) {
    const c = color(colorsEnabled());
    const answer = prompt(
      `remove ${tildify(root)}\n${c.yellow("this cannot be undone.")} [y/N]`,
    );
    if (answer?.trim().toLowerCase() !== "y") {
      out("aborted\n");
      return 1;
    }
  }
  removeEnv(name);
  out(`removed  ${name}\n`);
  return 0;
}


function pathCommand(args: string[], out: Out): number {
  const { envName, agent, name: category } = splitTargets(args);
  const root = resolveEnv(envName ?? undefined);
  if (!agent) {
    out(root + "\n");
    return 0;
  }
  if (!category) {
    out(agentDir(root, agent) + "\n");
    return 0;
  }
  if (!isCategory(category)) {
    throw new Error(`unknown category "${category}"\n\n  skills, plugins, mcp, hooks`);
  }
  if (category === "skills") {
    out(skillsDir(root, agent) + "\n");
    return 0;
  }
  out(path.join(agentDir(root, agent), category) + "\n");
  return 0;
}

/**
 * `tread doctor [env] [--fix]`
 *
 * The shared setup — shell hook, state dir, shims — is checked either way:
 * it is what every environment depends on, so naming one env narrows the
 * per-environment pass, never the common ground it stands on.
 */
function doctorCommand(args: string[], out: Out): number {
  const fix = takeFlag(args, "--fix");
  const only = args[0] ?? null;
  // fail before printing anything, so a typo does not read as a clean report
  if (only) requireEnv(only);
  const c = color(colorsEnabled());
  const ok = c.green("ok");
  const rows: string[][] = [];

  rows.push([
    "shell",
    shellLoaded() ? ok : c.yellow("not loaded"),
    shellLoaded()
      ? `${process.env.TREAD_SHELL}${activeName() ? ` · TREAD_ENV=${activeName()}` : ""}`
      : `eval "$(tread init zsh)"`,
  ]);

  // next to the shell row: both are the shell integration. Reported, not
  // counted — like the shims row, it is shared setup, not an environment's
  // problem. --fix repairs a file that has fallen behind this binary, but
  // never creates one: installing it is `init zsh --write`'s job, and a fish
  // user running --fix should not end up with a zsh file.
  const comp = completionState();
  if (comp === "stale" && fix) writeCompletion();
  rows.push([
    "completion",
    comp === "ok" ? ok
    : comp === "missing" ? c.dim("not installed")
    : fix ? c.green("regenerated") : c.yellow("stale"),
    comp === "missing"
      ? `${tildify(completionFile())} · ${c.dim("tread init zsh --write")}`
      : tildify(completionFile()),
  ]);

  const envs = only ? [only] : listEnvs();
  rows.push([
    "state dir",
    fs.existsSync(stateDir()) ? ok : c.dim("empty"),
    `${tildify(stateDir())} · ${listEnvs().length} envs`
      + (only ? ` · ${c.dim(`checking ${only} only`)}` : ""),
  ]);
  const healthy = shimsHealthy();
  if (!healthy && fix) writeShims();
  rows.push([
    "shims",
    healthy ? ok : fix ? c.green("regenerated") : c.yellow("stale"),
    tildify(shimsDir()),
  ]);
  for (const { name, agent } of shimNames()) {
    const bin = realBinary(name);
    const note = AGENT_SPECS[agent].needsHome ? c.dim("HOME redirected") : "";
    rows.push([`  ${name}`, bin ? ok : c.red("missing"), bin ? `${tildify(bin)}  ${note}` : ""]);
  }

  // reported once, not per environment: sharing is the default and the
  // mechanism belongs to the agent. An environment that opted out is the
  // exception and shows up in its own section below. Worth a row at all
  // because the symptom of any of these breaking is identical — a `/login`
  // prompt at the moment you switched environments — while the causes are
  // three different things in three different places.
  rows.push(["login", c.dim("shared"), c.dim("with every environment, unless login.isolate")]);
  for (const r of sharedLogin()) {
    rows.push([
      `  ${r.agent}`,
      r.present === null ? c.dim("n/a") : r.present ? ok : c.yellow("not logged in"),
      r.mechanism,
    ]);
  }
  out(table(rows).join("\n") + "\n\n");

  // collected rather than printed as they are found: the status column can
  // only line up once every name is known
  type Issue = { text: string; fixed: boolean };
  const results: { name: string; issues: Issue[] }[] = [];
  for (const name of envs) {
    const root = envDir(name);
    const issues: Issue[] = [];
    // what --fix actually repaired, as opposed to what it only reported
    const found = (text: string, fixed = fix) => issues.push({ text, fixed });

    // before the sync, which would otherwise queue behind this lock: one left
    // by a process that is gone makes the next activation wait out the full
    // timeout and then fail, for nothing
    const lock = syncLockFile(root);
    if (staleLock(lock)) {
      found(`.tread/sync.lock   left behind by a process that is gone`);
      if (fix) clearStale(lock);
    }

    // config is the source of truth and doctor never rewrites it: --fix only
    // brings the environment back in line with what the config already says,
    // so these two are reported and never marked fixed
    const sync = syncHomeLinks(root, { dryRun: !fix });
    for (const p of sync.problems) {
      found(`${tildify(p.file)}   ${p.message}`, false);
    }
    for (const rel of sync.missing) {
      found(`${rel}   allowed but not in ${tildify(realHome())}`, false);
    }
    if (sync.added.length > 0) {
      found(`${sync.added.length} path${sync.added.length === 1 ? "" : "s"} allowed but not linked yet`);
    }
    if (sync.pruned.length > 0) {
      found(`${sync.pruned.length} link${sync.pruned.length === 1 ? "" : "s"} no longer allowed`);
    }

    for (const n of ["credentials", "oauth"]) {
      const link = path.join(agentDir(root, "kimi"), n);
      if (isBrokenLink(link)) {
        found(`.kimi-code/${n}   broken symlink`);
        if (fix) {
          fs.rmSync(link, { force: true });
          ensureSkeleton(root);
        }
      }
    }
    // config decides this and doctor never rewrites config, so it is reported
    // and never marked fixed — logging in is the user's move, not --fix's
    for (const text of loginIssues(root)) found(text, false);

    const toml = path.join(agentDir(root, "kimi"), "config.toml");
    const want = skillsDir(root, "kimi");
    if (fs.existsSync(toml)) {
      const text = fs.readFileSync(toml, "utf8");
      if (text.includes("extra_skill_dirs") && !text.includes(want)) {
        found(`.kimi-code/config.toml   extra_skill_dirs points outside this env`);
        if (fix) {
          fs.writeFileSync(
            toml,
            text.replace(/extra_skill_dirs = \[[^\]]*\]/, `extra_skill_dirs = ["${want}"]`),
          );
        }
      }
    }
    results.push({ name, issues });
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // the status column reports what is still wrong, so an env whose every
  // issue was repaired does not go on claiming problems it no longer has
  const left = (r: { issues: Issue[] }) => r.issues.filter((i) => !i.fixed).length;
  const envRows = results.map((r) => [
    r.name,
    r.issues.length === 0 ? ok
    : left(r) === 0 ? c.green(`${plural(r.issues.length, "problem")} fixed`)
    : c.red(plural(left(r), "problem")),
  ]);
  table(envRows).forEach((line, i) => {
    out(line + "\n");
    for (const issue of results[i]!.issues) {
      out(`  ${c.red("✗")}  ${issue.text}${issue.fixed ? c.dim(" (fixed)") : ""}\n`);
    }
  });

  const remaining = results.reduce((n, r) => n + left(r), 0);
  if (remaining > 0) {
    out(
      `\n${plural(remaining, "problem")}.` +
        // --fix already ran, so what is left needs a config change, not a rerun
        (fix ? "\n" : `    tread doctor ${only ? `${only} ` : ""}--fix\n`),
    );
  }
  reportHomeLeak(out, c);
  return 0;
}

/**
 * Name the real-home config that reaches the agents from this directory.
 *
 * The list is the whole warning: why it gets through depends on which walk
 * the file is on, and that belongs in the README, not in front of someone
 * who only needs to know what is bleeding in.
 *
 * Kept out of the problem tally and away from `--fix`: it is a property of
 * where you happen to be standing, not of the environment, and nothing tread
 * writes can repair it. Reported by `doctor` because that is where someone
 * goes after noticing a skill they never installed.
 */
function reportHomeLeak(out: Out, c: Palette): void {
  const leak = homeLeak();
  if (!leak) return;
  // against the real home, not $HOME: an agent shelling out to tread has had
  // HOME moved, and the default would leave every path spelled out in full
  const short = (p: string) => (p === leak.home ? "~" : tildify(p, leak.home));
  const list = leak.surfaces.map((s) => short(path.join(leak.home, s))).join("  ");
  out(`\n${c.yellow("⚠")}  leaking in from ~:  ${list}\n`);
}

function isBrokenLink(p: string): boolean {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return !fs.existsSync(p);
}

const SHELL_NOT_LOADED =
  "shell integration not loaded\n\n" +
  "  `tread use` needs to modify the current shell.\n" +
  "  add this to ~/.zshrc, then restart your shell:\n\n" +
  '      eval "$(tread init zsh)"\n\n' +
  "  or run a one-off without activating:\n" +
  "      tread exec <env> -- claude";

export async function runCommand(argv: string[], out: Out, err: Out = out): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  const c = color(colorsEnabled());
  try {
    switch (cmd) {
      case "init": {
        const write = takeFlag(args, "--write", "-w");
        const target = args[0];
        if (!target) throw new Error("init needs a shell\n\n  tread init zsh");
        if (write) {
          const { file, changed, format } = writeInit(target);
          const where = tildify(file);
          if (format) {
            // starship re-reads its config on every prompt — nothing to restart.
            // What it does need is the module named in the top-level format.
            const note =
              format === "spliced" ? `  \${env_var.tread} added to your top-level format\n`
              : format === "manual" ? `  add \${env_var.tread} to your top-level format to see it\n`
              : "";
            err(
              changed || format === "spliced"
                ? `tread: ${changed ? "added to" : "updated"} ${where}\n${note}`
                : `tread: already present in ${where}\n`,
            );
          } else {
            err(
              changed
                ? `tread: added to ${where}\n  restart your shell, or: source ${where}\n`
                : `tread: already present in ${where}\n`,
            );
          }
          // bash and fish have no completion here, and starship is not a shell
          if (target === "zsh") {
            const first = completionState() === "missing";
            writeCompletion();
            err(
              `tread: completion ${first ? "written to" : "rewritten at"} ` +
                `${tildify(completionFile())}\n`,
            );
          }
          return 0;
        }
        out(initSnippet(target));
        return 0;
      }

      case "_export": {
        const sub = args.shift();
        if (sub === "deactivate") {
          // stdout is eval'd by the shell function, so talk on stderr
          out(deactivateLines());
          err(`tread: deactivated\n`);
          return 0;
        }
        if (sub !== "use") throw new Error(`unknown _export "${sub ?? ""}"`);
        const name = args[0];
        if (!name) throw new Error("use needs a name\n\n  tread use <name>");
        const lines = exportLines(name);
        out(lines);
        err(`tread: ${c.brightGreen(name)}\n`);
        return 0;
      }

      case "_complete": {
        const { code, text } = complete(args);
        if (text) out(text);
        return code;
      }

      case "use":
      case "deactivate":
        // reaching the binary means the shell function is not installed:
        // a child process cannot change its parent's environment
        throw new Error(SHELL_NOT_LOADED);

      case "create":
        return createCommand(args, out);

      case "cp":
        return cpCommand(args, out);

      case "ls": {
        const emit = takeOption(args, "--emit");
        const plain = takeFlag(args, "--plain");
        if (plain || !process.stdout.isTTY) {
          out(lsPlain(activeName()));
          return 0;
        }
        const { mountLs } = await import("./tui/ls.tsx");
        return await mountLs({ emit });
      }

      case "status": {
        const name = args[0];
        if (!name && !activeName()) {
          out(statusAll(null));
          return 0;
        }
        if (!name) {
          out(statusOne(resolveEnv(), activeName()!, true));
          return 0;
        }
        out(statusOne(requireEnv(name), name, activeName() === name));
        return 0;
      }

      case "show": {
        const plain = takeFlag(args, "--plain");
        const name = args[0] ?? activeName();
        if (!name) throw new Error("show needs an environment\n\n  tread show <env>");
        const root = requireEnv(name);
        if (plain || !process.stdout.isTTY) {
          out(showPlain(root, name, activeName() === name));
          return 0;
        }
        const { mountShow } = await import("./tui/show.tsx");
        return await mountShow(root, name);
      }

      case "skills":
      case "plugins":
      case "mcp":
      case "hooks":
        return await categoryCommand(cmd, args, out);

      case "path":
        return pathCommand(args, out);

      case "exec":
        return await execCommand(args, out);

      case "rm":
        return rmCommand(args, out);

      case "doctor":
        return doctorCommand(args, out);

      case "help":
      case "--help":
      case "-h":
        out(HELP);
        return 0;

      case "--version":
      case "-v":
        out(`tread ${VERSION}\n`);
        return 0;

      // bare `tread` is a usage error, not a request for help: still print it,
      // but exit non-zero so a script that forgot its argument notices
      case undefined:
        out(HELP);
        return 1;

      default:
        err(formatError(`unknown command "${cmd}"\n\n  tread help   to see all\n`) + "\n");
        return 1;
    }
  } catch (e) {
    // never stdout: for use/deactivate the caller evals stdout, and an error
    // message evaluated as shell is how you get "command not found: tread:"
    err(formatError(e instanceof Error ? e.message : String(e)) + "\n");
    return 1;
  }
}
