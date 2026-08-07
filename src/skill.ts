import fs from "node:fs";
import path from "node:path";
import { AGENTS } from "./agents.ts";
import { skillsDir } from "./paths.ts";
import { VERSION } from "./version.ts";

export const TREAD_SKILL_NAME = "tread";

/**
 * The guide tread installs into every environment.
 *
 * Written for an agent that has to *act*, not one that has to understand
 * tread: the mechanism (policy trees, layered patches, mirror-versus-link)
 * stays in the source. What an agent needs is which symptom means which edit,
 * in which file, with which exact text — so that is all this says.
 */
function body(): string {
  return `---
name: tread
version: ${VERSION}
description: Use when working inside a tread environment, or when the user mentions tread, isolated agent environments, or TREAD_ENV. Also use when a command fails inside an environment because a config or credential from the user's home is missing, when asked where skills/plugins/MCP servers/hooks got installed, or when \`~\` resolves somewhere unexpected.
---

# tread

tread gives each coding agent isolated environments — conda for agent tooling.
Skills, plugins, MCP servers and hooks installed in one are invisible to the
others and to the user's real setup.

## First: are you in one?

\`\`\`sh
echo $TREAD_ENV        # environment name, empty if not activated
\`\`\`

If it is empty, none of this applies — you are on the user's real setup, and
anything you install goes to their real home. That is correct, not a bug.

If it is set, two facts matter:

- **\`$HOME\` is the environment, not the user's home.** \`~/.claude\`,
  \`~/.cursor\`, \`~/.kimi-code\` and anything else you resolve through \`$HOME\`
  or \`os.homedir()\` already point inside it.
- **The user's real home is \`$TREAD_HOME\`.** Use it whenever you genuinely
  mean their machine rather than this environment.

## Installing skills, plugins, MCP servers, hooks

Use each agent's own tooling, unchanged. Because \`$HOME\` already points into
the environment, a normal install lands in the right place.

**tread never installs anything itself.** It only shows you what is there:

\`\`\`sh
tread skills                   # all agents in the active environment
tread skills claude            # one agent
tread skills claude <name>     # one skill in detail
tread plugins / tread mcp / tread hooks    # same shape
tread mcp claude --probe       # actually connect to each server
\`\`\`

Ask \`tread path\` instead of guessing where something lives:

\`\`\`sh
tread path                     # environment root
tread path claude              # its claude config dir
tread path claude skills       # skills | plugins | mcp | hooks
\`\`\`

## Configuring what the environment shares

An environment starts with the user's dotfiles for ordinary tools — git, ssh,
\`.config\`, npm, cargo, the toolchain managers — shared in from their real
home. Everything else stays inside the environment.

You only need to touch the config in these two situations.

### 1. A tool fails inside the environment because its config is missing

Symptoms: git commits with the wrong author; \`gh\`/\`npm\`/\`aws\` says not
authenticated; a CLI cannot find its profile — **and the same command works
outside the environment.**

Confirm, then share that path in:

\`\`\`sh
ls $TREAD_HOME/.foo     # exists in the real home
ls ~/.foo               # missing here → that is the cause
\`\`\`

\`\`\`yaml
# $TREAD_ENV_DIR/.tread/config.yaml
allow:
  extra: [.foo]
\`\`\`

### 2. Something is shared that should not be

Too large, or the user does not want it visible to agents:

\`\`\`yaml
# $TREAD_ENV_DIR/.tread/config.yaml
allow:
  remove: [.cache]
\`\`\`

### Which file to edit

| | |
|---|---|
| just this environment | \`$TREAD_ENV_DIR/.tread/config.yaml\` |
| every environment | \`$TREAD_HOME/.config/tread/config.yaml\` |

Prefer the per-environment file unless the user asks for the change everywhere.
Note the second path uses \`$TREAD_HOME\`: writing \`~/.config/tread/config.yaml\`
from in here would create a file inside the environment that nothing reads.

### Rules

- Paths are relative to the home, no leading \`/\` and no \`..\`: \`.foo\`, \`.config/bar\`.
- \`extra\` and \`remove\` are **additions to tread's defaults**, not the whole
  list. List only what you are changing.
- Apply it with \`tread doctor --fix\`, or by re-running \`tread use <env>\`.
- The agent directories (\`.claude\`, \`.cursor\`, \`.kimi-code\`, \`.agents\`) can
  never be shared. Isolating them is the whole point; \`tread doctor\` will say
  so if you try.

Do not edit the config for anything else. In particular, a skill or tool
writing its own state into the environment is working as intended — that data
is *supposed* to stay here.

## Environment lifecycle

\`\`\`sh
tread ls                   # browse and switch (interactive; --plain for text)
tread status [env]         # what each environment holds
tread show [env]           # browse one environment
tread create <name>
tread cp <src> <dst>       # copy an environment; the two are then unrelated
tread use <name>           # activate in this shell
tread deactivate
tread rm <name> [--force]
\`\`\`

\`use\` and \`deactivate\` change the calling shell, so they need the shell
integration (\`tread init zsh --write\`, then restart the shell). Without it,
run a one-off instead:

\`\`\`sh
tread exec <env> -- claude -p "hi"
tread exec <env> --home -- <cmd>    # --home also moves HOME for that command
\`\`\`

## When something looks wrong

\`\`\`sh
tread doctor               # report only, every environment
tread doctor --fix         # repair: shims, shared links, stale leftovers
tread doctor <env> [--fix]  # the shared setup plus that one environment
\`\`\`

- **Something landed in the user's real home.** Check \`$TREAD_ENV\` first. If it
  is set, the installer used an absolute path instead of \`$HOME\`.
- **\`tread use\` says the shell integration is not loaded.** A child process
  cannot change its parent's environment — \`tread init zsh --write\`.
- **\`tread\` reports no environments.** You are on a tread older than ${VERSION};
  it could not see past the moved \`$HOME\`. Ask the user to reinstall.

This file is generated by tread ${VERSION} and refreshed on every activation.
Edit tread, not this copy.
`;
}

/** Write the guide into every agent's skills dir. Idempotent. */
export function installTreadSkill(envRoot: string): string[] {
  const text = body();
  const written: string[] = [];
  for (const a of AGENTS) {
    const dir = path.join(skillsDir(envRoot, a), TREAD_SKILL_NAME);
    const file = path.join(dir, "SKILL.md");
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {}
    if (existing === text) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    written.push(a);
  }
  return written;
}

export function treadSkillBody(): string {
  return body();
}
