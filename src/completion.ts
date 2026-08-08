import { AGENTS, type Agent } from "./agents.ts";
import { listEnvs, resolveEnv } from "./env.ts";
import { readHooks, readMcp, readPlugins, readSkills } from "./inspect/index.ts";
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
