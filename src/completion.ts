import fs from "node:fs";
import { AGENTS, type Agent } from "./agents.ts";
import { writeFileAtomic } from "./atomic.ts";
import { listEnvs, resolveEnv } from "./env.ts";
import { readHooks, readMcp, readPlugins, readSkills } from "./inspect/index.ts";
import { completionFile } from "./paths.ts";
import { SHELLS } from "./shell.ts";
import { CATEGORIES, isCategory, splitTargets, type Category } from "./views.ts";

export interface Candidate {
  value: string;
  description?: string;
}

/**
 * Every subcommand the completion offers, with the summary zsh shows beside it.
 *
 * `_export` and `_complete` are deliberately absent: they exist for the shell
 * function and for this file, and nobody types them. A test holds this list
 * against HELP so the two cannot drift apart.
 */
export const COMMANDS: Candidate[] = [
  { value: "init", description: "print shell integration" },
  { value: "create", description: "create an environment" },
  { value: "cp", description: "copy an environment" },
  { value: "use", description: "activate it in this shell" },
  { value: "deactivate", description: "leave the active environment" },
  { value: "ls", description: "browse and switch environments" },
  { value: "status", description: "what each environment holds" },
  { value: "show", description: "browse one environment" },
  { value: "skills", description: "list or inspect skills" },
  { value: "plugins", description: "list or inspect plugins" },
  { value: "mcp", description: "list or inspect MCP servers" },
  { value: "hooks", description: "list or inspect hooks" },
  { value: "path", description: "print a directory" },
  { value: "exec", description: "run a command in an environment" },
  { value: "rm", description: "delete an environment" },
  { value: "doctor", description: "check the setup" },
];

/**
 * One candidate per line, `value` or `value:description`.
 *
 * Both halves need cleaning up. zsh's _describe reads the first unescaped
 * colon as the split, so a colon inside a value would silently truncate it;
 * and a description spanning lines — a skill's, typically — would read back
 * as several candidates.
 */
export function renderCandidate(c: Candidate): string {
  const value = c.value.replaceAll(":", "\\:");
  const description = c.description?.replace(/\s+/g, " ").trim();
  return description ? `${value}:${description}` : value;
}

function envCandidates(): Candidate[] {
  const active = process.env.TREAD_ENV;
  return listEnvs().map((name) => ({
    value: name,
    description: name === active ? "active" : undefined,
  }));
}

function agentCandidates(): Candidate[] {
  return AGENTS.map((a) => ({ value: a }));
}

function itemCandidates(root: string, a: Agent, cat: Category): Candidate[] {
  switch (cat) {
    case "skills":
      return readSkills(root, a).map((s) => ({
        value: s.name,
        description: s.description ?? undefined,
      }));
    case "plugins":
      return readPlugins(root, a).map((p) => ({
        value: p.name,
        description: p.description ?? undefined,
      }));
    case "mcp":
      return readMcp(root, a).map((m) => ({ value: m.name, description: m.transport }));
    case "hooks": {
      // readHooks returns one row per handler, so an event with two handlers
      // would otherwise be offered twice
      const events = new Set(readHooks(root, a).map((h) => h.event));
      return [...events].sort().map((e) => ({ value: e }));
    }
  }
}

/**
 * Candidates for the next positional of `[env] [agent] [name]`.
 *
 * The words already typed go straight back through splitTargets(), so the
 * "first word that is not an agent is the environment" rule stays in the one
 * place that already owns it. Which slot is open falls out of what it returns.
 */
function targetCandidates(cmd: string, typed: string[]): Candidate[] {
  const { envName, agent, name } = splitTargets(typed);
  if (name !== null) return [];

  const out: Candidate[] = [];
  // an item name is not reachable in the first slot: splitTargets would read
  // it as an environment, whatever it happens to be
  if (envName === null && agent === null) out.push(...envCandidates());
  if (agent === null) out.push(...agentCandidates());

  // `path` names a category last, and pathCommand only reads one once the
  // agent is settled — before that the word is swallowed as the agent slot
  if (cmd === "path") {
    if (agent !== null) out.push(...CATEGORIES.map((c) => ({ value: c })));
    return out;
  }

  // the item slot opens as soon as either leading slot is settled: `tread
  // skills work <TAB>` may still be naming an agent, but it may equally be
  // naming a skill, which categoryCommand resolves against claude by default
  if (!isCategory(cmd) || (envName === null && agent === null)) return out;
  try {
    out.push(...itemCandidates(resolveEnv(envName ?? undefined), agent ?? "claude", cmd));
  } catch {
    // nothing typed and nothing active: there is no environment to read
  }
  return out;
}

/**
 * `tread _complete <what> [...]` — the data half of the zsh completion.
 *
 * Hidden the way `_export` is: an implementation detail of `_tread`, not a
 * command anyone types. An unknown request exits 1 and writes nothing, so a
 * `_tread` left over from an older tread can ask for something this binary
 * does not have and simply get no suggestions.
 */
export function complete(args: string[]): { code: number; text: string } {
  const [what, ...rest] = args;
  let list: Candidate[];
  switch (what) {
    case "commands":
      list = COMMANDS;
      break;
    case "shells":
      list = SHELLS.map((s) => ({ value: s }));
      break;
    case "envs":
      list = envCandidates();
      break;
    case "targets": {
      const [cmd, ...typed] = rest;
      if (!cmd) return { code: 1, text: "" };
      list = targetCandidates(cmd, typed);
      break;
    }
    default:
      return { code: 1, text: "" };
  }
  return { code: 0, text: list.length ? list.map(renderCandidate).join("\n") + "\n" : "" };
}

/**
 * The zsh completion function.
 *
 * The grammar is here — which command takes which positionals and flags — and
 * nothing else is: every candidate comes from `tread _complete` at the moment
 * TAB is pressed. So a file left behind by an older tread still completes a
 * command that binary has since grown; only the flags would be missing.
 */
export const ZSH_COMPLETION = `#compdef tread

# Generated by \`tread init zsh --write\`; \`tread doctor --fix\` rewrites it.
# Do not edit: the grammar lives here, every candidate comes from the binary.

_tread_ask() {
  local tag=$1; shift
  local -a candidates
  candidates=(\${(f)"$(command tread _complete "$@" 2>/dev/null)"})
  (( $#candidates )) || return 1
  _describe -t "$tag" "$tag" candidates
}

_tread_envs()   { _tread_ask environment envs }
_tread_shells() { _tread_ask shell shells }

# tread reads \`[env] [agent] [name]\` by position, so the flags typed so far are
# dropped and the rest handed over exactly as tread itself would read them.
_tread_targets() {
  local -a typed
  typed=(\${(M)words[2,CURRENT-1]:#[^-]*})
  _tread_ask target targets $words[1] $typed
}

_tread() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '(- *)'{-h,--help}'[show help]' \\
    '(- *)'{-v,--version}'[show the version]' \\
    '1: :->cmd' \\
    '*:: :->args'

  case $state in
    cmd)
      _tread_ask command commands
      ;;
    args)
      case $words[1] in
        init)
          _arguments \\
            '(-w --write)'{-w,--write}'[append it to your shell rc]' \\
            '1:shell:_tread_shells'
          ;;
        use|status)
          _arguments '1:environment:_tread_envs'
          ;;
        show)
          _arguments '--plain[print instead of opening the TUI]' \\
                     '1:environment:_tread_envs'
          ;;
        ls)
          _arguments '--plain[print instead of opening the TUI]'
          ;;
        cp)
          _arguments '1:source:_tread_envs' '2:new name: '
          ;;
        rm)
          _arguments '(-f --force)'{-f,--force}'[skip the confirmation]' \\
                     '1:environment:_tread_envs'
          ;;
        doctor)
          _arguments '--fix[repair what it can]' '1:environment:_tread_envs'
          ;;
        exec)
          _arguments '--home[point HOME at the environment]' \\
                     '1:environment:_tread_envs' \\
                     '(-)*::command:_normal'
          ;;
        mcp)
          _arguments '--probe[contact each server]' '*: :_tread_targets'
          ;;
        skills|plugins|hooks|path)
          _tread_targets
          ;;
      esac
      ;;
  esac
}

_tread "$@"
`;

/**
 * Atomic for the same reason the shims are: compinit may be reading this file
 * right now, and a truncate-then-write would hand it half a function.
 */
export function writeCompletion(): void {
  writeFileAtomic(completionFile(), ZSH_COMPLETION);
}

/** Missing, or written by a tread that is no longer the one on PATH. */
export function completionState(): "ok" | "stale" | "missing" {
  let text: string;
  try {
    text = fs.readFileSync(completionFile(), "utf8");
  } catch {
    return "missing";
  }
  return text === ZSH_COMPLETION ? "ok" : "stale";
}
