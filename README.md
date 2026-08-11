# tread

A conda-style environment manager for AI coding agents. It gives Claude Code, Cursor Agent and Kimi Code environments that are isolated from each other and from your real home. Activate once, then `claude` / `cursor-agent` / `kimi` run inside the environment.

**tread does not install skills, plugins, MCP servers or hooks.** It gives you isolated containers and an inspector; you install things with each agent's own tooling.

[中文文档](README.zh-CN.md) · macOS (Apple Silicon) only

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Hanyang-Li/tread/main/install.sh | sh
```

The script downloads the Apple Silicon binary from GitHub Releases into `~/.local/bin` (no sudo), verifies its sha256, puts `~/.local/bin` on your `PATH`, and runs `tread init <your shell> --write`. Set `VERSION=v0.2.0` to pin a release, `INSTALL_DIR=/path` to install elsewhere, or `NO_MODIFY_PATH=1` to leave your shell rc alone and print the manual steps instead.

Then open a new terminal, or `source ~/.zshrc`.

The binary is self-contained — it does not need bun, node or any vendored CLI at run time.

Where things live:

| path | what |
|---|---|
| `~/.local/bin/tread` | the binary |
| `~/.local/state/tread/envs/<name>/` | one environment (`TREAD_STATE_DIR` overrides the root) |
| `~/.local/state/tread/shims/` | agent launcher shims (`tread doctor --fix` rebuilds them) |
| `~/.local/state/tread/state.json` | last-used timestamps |
| `~/.local/share/tread/_tread` | zsh completion |
| `~/.config/tread/config.yaml` | optional global config |

### Shell integration

`tread init zsh --write` does two things: it appends `eval "$(tread init zsh)"` to `~/.zshrc` inside a marked block, and it writes the tab completion to `~/.local/share/tread/_tread`, which the eval line wires into `fpath`. Completion covers subcommands, environment names, agent names, categories, and the skills / plugins / MCP servers / hook events each environment actually holds.

You can also add just that one line by hand:

```sh
eval "$(tread init zsh)"
```

That skips the completion — the snippet quietly does nothing when `_tread` is absent, and `tread doctor` will tell you it is not installed.

bash and fish work the same way but have no completion; fish uses `tread init fish | source`.

`tread use` and `tread deactivate` need this integration, because a child process cannot change its parent shell's environment. In scripts, use `tread exec` instead.

### starship

```sh
tread init starship --write     # does both steps for you
tread init starship             # or print it and paste it yourself
```

starship only renders the modules its top-level `format` names, so adding an `[env_var.tread]` table is not enough on its own: a config with an explicit `format` also needs `${env_var.tread}` in it, or the pill never appears. `--write` does both — appends the module, and splices `${env_var.tread}` to the front of the top-level `format` (configs without one are left alone; the default `$all` already covers `env_var.*`). Move that one reference if you want the pill somewhere else. It disappears when no environment is active.

## Quick start

```sh
tread create work
tread use work

claude          # runs against the work environment's config
cursor-agent    # same
kimi            # same

tread deactivate    # back to your own ~/.claude and friends
```

A new terminal starts deactivated, and your real home is untouched. While deactivated the shims are not on `PATH`, so `claude` is the real claude; even called directly, a shim passes straight through.

## Commands

```
tread init <zsh|bash|fish|starship>   print the shell integration
tread create <name>                   create an environment
tread cp <src> <dst>                  copy an environment
tread use <name> / deactivate         activate / leave
tread ls                              browse and switch environments (TUI)
tread status [env]                    what each environment holds
tread show [env]                      browse one environment (TUI)

tread skills  [env] [agent] [name]    list or inspect (read-only)
tread plugins [env] [agent] [name]
tread mcp     [env] [agent] [name] [--probe]
tread hooks   [env] [agent] [event]

tread path [env] [agent] [category]   print a directory
tread exec <env> [--home] -- <cmd>    run one command inside an environment
tread rm <name> [--force]             delete an environment
tread doctor [env] [--fix]            check the setup, or just one environment
```

`ls` and `show` are TUIs — rounded borders, keyboard and mouse, resizing with the window. They fall back to plain text when stdout is not a TTY, when `--plain` is passed, or when the terminal is smaller than 30×8.

### `cp` copies the toolchain, not a snapshot

`cp` copies skills, plugins, MCP servers, hooks, commands and the directories the agents created themselves, byte for byte. Session records, history, logs, telemetry and caches are not copied — in a measured 26M environment those were half of it, and they describe what some *other* environment did. When it finishes it prints the new environment's `status` table, identical to `tread status <dst>`.

**The two environments are completely unrelated afterwards.** That takes two things, and "don't use symlinks" is not enough on its own:

Links that point into your real home are regenerated from the *new* environment's own config rather than copied from the source — the allow list in effect when the source was created may be nothing like your config today. Other links stay links, but an absolute link pointing inside the source environment is rewritten to the new environment's own copy; otherwise the new environment would just be an alias of the old one. Deciding which links are "shared" has to exclude `~/.local/state/tread`: environments live under your real home, so without that carve-out a sibling link inside a plugin tree, like `AGENTS.md -> CLAUDE.md`, would be misread as shared and dropped.

**Absolute paths to the source environment are rewritten inside file contents.** Agents hard-code their own config dir into what they write: claude's hook commands and `installed_plugins.json`, cursor's `hooks.json`, kimi's `extra_skill_dirs`, and whatever paths a skill's own installer computed. Without the rewrite the new environment silently reads the old one's directories — you edit a hook in the new environment and the old one still runs. Only complete absolute paths are replaced, never the environment *name*: a name like `test` would hit prose everywhere.

The exclude list matches **env-relative paths exactly**, not directory names: `.claude/cache` is junk, `.claude/plugins/cache` is the plugin bodies (those 9.3M). Matching by name would delete every plugin while `status` kept reporting them as installed, because the counts come from the manifest.

### MCP connectivity

`tread mcp` does only the free checks by default: no requests to http servers, and for stdio servers just "does the command exist and is it executable".

`--probe` (`t` in the TUI) performs a full MCP handshake and lists the tools. The handshake **streams and stops at the response** rather than waiting for the server to exit or the stream to close — an MCP server is supposed to stay alive after answering.

http probes try `fetch` first and fall back to `curl`. Bun's fetch does not support socks5, and it rejects the `Transfer-Encoding: chunked` some local proxies put on a CONNECT response as an invalid response; curl handles both, and reads the same proxy environment variables. That is what makes `ep tread mcp … --probe` work behind a proxy.

Probing is opt-in on purpose: **an stdio MCP server has no observable "connection"** — it is a subprocess the agent forks per session, so probing it means starting a new instance; and an http probe sends the credentials you stored. Both should happen when you press the key, not before.

MCP headers and env are shown **key only, values always masked**.

## Installing tools: use each agent's own tooling

With an environment activated:

```sh
# plugins
claude plugin install <name>@<marketplace>
cursor-agent plugin marketplace add <url>
kimi                                        # /plugins in the TUI

# MCP
claude mcp add ...
cursor-agent mcp ...
$EDITOR "$(tread path work kimi)/mcp.json"

# hooks
$EDITOR "$(tread path work claude)/settings.json"

# skills (any installer; --home makes $HOME-resolving tools land in the environment)
tread exec work --home -- skills add vercel-labs/agent-skills -g -a claude-code
tread exec work --home -- clawhub install <name>
```

Every environment ships with a `tread` skill, installed into all three agents' skills directories and refreshed on each activation. It documents the whole CLI, where each directory is, and the fact that "your `$HOME` is not the user's real home" — the thing an agent is most likely to get wrong. Better to put the explanation within its reach than to hope the user explains it.

## How it works

Activating does two things: it exports each agent's config-dir variable, and it puts `<state>/shims` at the front of `PATH`.

| agent | variable | location in the environment |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `<env>/.claude/` |
| cursor | `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` | `<env>/.cursor/` |
| kimi | `KIMI_CODE_HOME` | `<env>/.kimi-code/`, `<env>/.agents/skills/` |

**Why config-dir variables are not enough.** A variable only governs the paths the agent resolves *itself*, not the third-party code it runs. Cursor's `mcp.json` and `hooks.json` are hard-coded to `join(homedir(), ".cursor", …)` and ignore `CURSOR_CONFIG_DIR` entirely; kimi's user-level skills live in `~/.agents/skills`; claude does honour `CLAUDE_CONFIG_DIR` throughout, but a skill that installs a hook will compute `join(homedir(), ".claude", "settings.json")` and write into your real home anyway.

So **all three** shims point `HOME` at the environment root. That only applies to the agent process — it is set inside the shim and never pollutes your shell.

Moving HOME has a cost: claude uses `$HOME` as the stopping point when it walks up looking for project-level config, and once HOME moves, your real home is no longer a boundary. See the directory-related leaks in [Known limitations](#known-limitations); `tread doctor` reports them for the directory you are actually in.

The environment directory is shaped like a home, with the **permitted parts** of your real home symlinked in:

```
shared by default:  .gitconfig  .ssh  .config  .cache  .npmrc  .cargo  .rustup
                    .asdf  .tool-versions  .docker  .kube  .aws  …  (see defaultAllow)
never shared:       .claude  .cursor  .kimi-code  .agents  .local/state
                    .tread  .config/tread
                    Library/Application Support/Cursor/User/globalStorage   ← macOS
```

An environment isolates the agent toolchain, not your whole account — agents still shell out to git, ssh and npm, so the shared surface has to be wide. tread ships the list itself: making every user rediscover "oh, git needs that one" is a bad trade.

**Anything not on the list stays inside the environment.** That is the property that matters: a state directory some skill invents for itself is isolated for free, without tread having to know its name in advance.

Changing the shared set is YAML, and it is a **patch, not a full list** — so when tread's defaults grow later, you get the additions too:

```yaml
# ~/.config/tread/config.yaml     every environment
# <env>/.tread/config.yaml        one environment
allow:
  extra:  [.my-tool]
  remove: [.cache]
```

Three layers stack: built-in defaults → global → per-environment. Within a layer `remove` beats `extra`; across layers a later `extra` can add back what an earlier layer removed. Use `replace:` to discard the defaults entirely.

Config cannot touch the "never shared" entries (`doctor` reports it if you try): the agent directories have to be real directories inside the environment or there is no isolation at all; `.local/state` is tread's own state, and linking it would nest the environment inside itself; `.tread` and `.config/tread` are the config, and covering them with a link breaks the bootstrap.

Refusals nest: `.config` is shared as a whole, but the `tread` subdirectory inside it is carved out — that one level becomes a mirrored real directory instead of a single symlink, and its siblings stay shared. The macOS entry works the same way; it is where the Cursor desktop app caches its skill and plugin index.

Links are **re-synced on every activation**. Each environment keeps its own manifest (`<env>/.tread/sync.json`), so removing an entry from the config really does detach the link — tightening the config without detaching is the worst way for an allow list to fail. Detaching only touches symlinks that point at your real home, plus empty directories; never `rm -r`. Real files created inside the environment always win.

### Logins are shared, not per environment

You log in once, on your real home, and every environment is already logged in — `create` and `cp` alike. Each agent gets there differently, and only one of them needed tread to do anything about it:

| agent | credential store | how it reaches an environment |
|---|---|---|
| cursor | keychain, fixed service name | sharing `Library/Keychains` is the whole mechanism |
| kimi | files (`~/.kimi-code/credentials`, `oauth/`) | symlinked back on `create`; `config.toml` stays per environment |
| claude | keychain, **service name includes a hash of `CLAUDE_CONFIG_DIR`** | needs `CLAUDE_SECURESTORAGE_CONFIG_DIR` defined and empty |

claude is the odd one out. Its service name is built as `Claude Code-credentials` plus the first 8 hex of the config dir's sha256, so pointing `CLAUDE_CONFIG_DIR` at an environment silently names a *different* keychain item — which is why a fresh environment used to demand its own `/login`, and why copying the config dir never helped. Setting `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the **empty string** drops the hash and the item becomes the one your real home already uses. Empty, not unset: those mean opposite things, and claude ships a special case so the empty value survives into subprocesses. The shims do this for you.

To give one environment its own account instead:

```yaml
# <env>/.tread/config.yaml
login:
  isolate: [claude]
```

That environment goes back to its own keychain item and its own `/login`. `tread doctor` reports which item each environment resolves and whether it exists, so a claude release changing the construction shows up as a warning instead of as a surprise login prompt.

Two things worth knowing. Every environment shares one account — that is the point, but it means `login: isolate` is the only way to run two. And the read-modify-write lock claude takes around credential refresh lives in each environment's own directory, so it does not span environments; running several at once while a token happens to be rotating can, rarely, cost you one re-login.

### Known limitations

- **The macOS login keychain must be shared (`Library/Keychains`).** The keychain is located via `$HOME`, so once HOME moves, `security default-keychain` fails outright with *a default keychain could not be found* — claude's and cursor's login state is all in there, and the symptom is being unable to log in at all, with a dialog about a missing keychain. Only `Library/Keychains` is shared; `Library` itself is a mirrored directory, so other apps' state stays isolated.

- **cursor downloads your account's default plugins into a new environment.** Measured: 32 seconds after creating an environment it had pulled `dbt / github / redis-development / superpowers` on its own. They are independent copies, not a leak, but a new environment is not empty as far as cursor is concerned. Clear them with `cursor-agent plugin`.

- **Starting claude in a directory that is under your real home and not inside a git repo leaks your real `~/.claude` in as project scope.** The way claude finds project-level skills / agents / commands is by collecting `<ancestor>/.claude/…` upward from the cwd, and that walk stops only at a `.git` or at `$HOME`. Once the shim points HOME at the environment root, your real home is no longer the end of the walk, so it climbs right past it — those skills show up in `/skills` labelled `project` instead of `user`. **Working inside a git repo avoids this**, since the repo root truncates the walk. So does keeping your work outside your home directory. (A temporary empty `.git` as a boundary was tried: it does truncate the walk, but claude then treats a non-repo directory as a git repo, and project-level writes land in that fake repo root. Not worth it; abandoned.)

- **A second family leaks from any directory under home, `.git` does not stop it, and the environment cannot turn it off.** Those use a different walk: all the way to `/`, including `$HOME` itself. It has nothing to do with HOME being moved — it leaked identically before the shim change.

  Measured one by one, what leaks and what does not:

  | location | leaks from an ancestor | `.git` stops it |
  |---|---|---|
  | `~/.claude/skills`, `agents`, `commands` | yes | **yes** |
  | `~/.claude/CLAUDE.md`, `~/CLAUDE.md` | yes | no |
  | `~/.mcp.json` | yes (listed in `mcp list`, pending approval) | no |
  | `~/AGENTS.md`, `~/.cursor/rules` | yes, **cursor reads them** (claude does not read `AGENTS.md`) | no |
  | `~/.claude/settings.json` | **no** | — |
  | `~/.cursor/skills` | **no** | — |
  | all of kimi's (`~/.agents/skills` etc.) | **no** | — |

  `tread doctor` reports against your current directory, and only for the ones that **actually exist** — `~/AGENTS.md` and `~/.mcp.json` do not exist by default, so if you never created them they never show up in the warnings.

- **Only environment-level (global) content is managed.** Project-scope skills / plugins / MCP servers / hooks are neither read nor displayed — those belong to each agent.

- **A new kimi environment is seeded with the provider / model config from your real home** (hooks stripped). kimi stores model settings separately from credentials, and without the seed the environment will not start.

- `tread use` requires the shell integration. Use `tread exec` in scripts.

## Development

```sh
bun install
bun test              # 271 tests, e2e included
bun run typecheck
bun run src/index.ts  # run straight from source
```

Build and install the binary from source — requires Bun ≥ 1.3, and `~/.local/bin` on your `PATH`:

```sh
./build.sh            # compiles to ~/.local/bin/tread (TREAD_BIN_DIR overrides)
tread init zsh --write
source ~/.zshrc
```

`bun run build` does the same compile into `dist/tread` without installing it.

Design documents are in `docs/superpowers/specs/`, implementation plans in `docs/superpowers/plans/`.

### Releasing

Pushing a tag that starts with `v` triggers the GitHub Action, which builds the `aarch64-apple-darwin` binary, ad-hoc signs it, and uploads `tread-aarch64-apple-darwin.tar.gz` plus its `.sha256` to the matching Release:

```sh
git tag v0.2.0
git push origin v0.2.0
```

## License

[MIT](LICENSE)
