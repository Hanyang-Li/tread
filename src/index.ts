#!/usr/bin/env bun
import { AGENTS, isAgent, type Agent } from "./paths.ts";
import { createEnv, listEnvs, parseAgentEnv, removeEnv, requireEnv } from "./env.ts";
import { runAgent } from "./run.ts";
import { skillCmd } from "./skill.ts";
import { claudePlugin } from "./plugin/claude.ts";
import { cursorPlugin } from "./plugin/cursor.ts";
import { kimiPlugin } from "./plugin/kimi.ts";
import { showHooks, showMcp } from "./inspect.ts";

const HELP = `tread — pyenv-style isolated environments for AI agents

usage: tread <command> [args]

env management:
  create <agent> <name>        create an environment (agent: ${AGENTS.join("|")})
  ls [agent]                   list environments
  rm <agent> <name> [--force]  remove an environment
  path <agent> <name>          print the environment directory
  run <agent> <name> [-- args] launch the agent inside the environment

content management:
  skill add <agent> <env> <source> [--skill <name>]...
  skill ls|rm|update <agent> <env> [...]
  plugin add <agent> <env> <source> [name]
  plugin ls|rm|update <agent> <env> [...]
  hooks <agent> <env>          show configured hooks (read-only)
  mcp <agent> <env>            show configured MCP servers (read-only)

plugin sources:
  claude  <marketplace-source> [name@marketplace]   (official claude plugin CLI)
  kimi    official|<marketplace-url> [id] | <github-url|zip-url|local-path>
  cursor  <marketplace-git-url> [plugin-name]       (loaded via --plugin-dir)

environment: TREAD_STATE_DIR, TREAD_SHARE_DIR override default locations
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "create": {
      const { agent, name } = parseAgentEnv(rest);
      console.log(createEnv(agent, name));
      return 0;
    }
    case "ls": {
      const agent = rest[0];
      if (agent && !isAgent(agent)) throw new Error(`unknown agent "${agent}"`);
      const all = listEnvs(agent as Agent | undefined);
      for (const [a, envs] of Object.entries(all)) {
        console.log(`${a}:`);
        for (const e of envs) console.log(`  ${e}`);
        if (envs.length === 0) console.log("  (none)");
      }
      return 0;
    }
    case "rm": {
      const force = rest.includes("--force");
      const { agent, name } = parseAgentEnv(rest.filter((a) => a !== "--force"));
      const dir = requireEnv(agent, name);
      if (!force) {
        const answer = prompt(`remove ${dir}? [y/N]`);
        if (answer?.toLowerCase() !== "y") {
          console.log("aborted");
          return 1;
        }
      }
      removeEnv(agent, name);
      console.log(`removed ${dir}`);
      return 0;
    }
    case "path": {
      const { agent, name } = parseAgentEnv(rest);
      console.log(requireEnv(agent, name));
      return 0;
    }
    case "run": {
      const sep = rest.indexOf("--");
      const head = sep === -1 ? rest : rest.slice(0, sep);
      const agentArgs = sep === -1 ? [] : rest.slice(sep + 1);
      const { agent, name } = parseAgentEnv(head);
      // extra args before -- are also passed through (after env name)
      return await runAgent(agent, name, [...head.slice(2), ...agentArgs]);
    }
    case "skill": {
      const [action, ...tail] = rest;
      if (!action) throw new Error("usage: tread skill <add|ls|rm|update> <agent> <env> [...]");
      const { agent, name } = parseAgentEnv(tail);
      return await skillCmd(action, agent, name, tail.slice(2));
    }
    case "plugin": {
      const [action, ...tail] = rest;
      if (!action) throw new Error("usage: tread plugin <add|ls|rm|update> <agent> <env> [...]");
      const { agent, name } = parseAgentEnv(tail);
      const pluginArgs = tail.slice(2);
      switch (agent) {
        case "claude":
          return await claudePlugin(action, name, pluginArgs);
        case "cursor":
          return await cursorPlugin(action, name, pluginArgs);
        case "kimi":
          return await kimiPlugin(action, name, pluginArgs);
      }
      break;
    }
    case "hooks": {
      const { agent, name } = parseAgentEnv(rest);
      showHooks(agent, name);
      return 0;
    }
    case "mcp": {
      const { agent, name } = parseAgentEnv(rest);
      showMcp(agent, name);
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return cmd === undefined ? 1 : 0;
    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(HELP);
      return 1;
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`tread: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
