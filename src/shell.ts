import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activationEnv, shimsDir } from "./paths.ts";
import { ensureSkeleton, requireEnv, touchLastUsed } from "./env.ts";
import { writeShims } from "./shims.ts";

/**
 * `use` and `deactivate` must mutate the caller's shell, so their output is
 * eval'd — which means a failure must never reach eval. Capture first, bail
 * on a non-zero exit, only then evaluate. Diagnostics go to stderr.
 *
 * `ls` can activate too, but it is a TUI: it renders on the terminal and
 * writes the export lines to the --emit file. `show` is read-only.
 */
function posix(shell: string): string {
  return `# tread shell integration — eval "$(tread init ${shell})"
tread() {
  case "$1" in
    use|deactivate)
      local __o
      __o=$(command tread _export "$@") || return $?
      eval "$__o" ;;
    ls)
      local __f
      __f=$(mktemp -t tread) || return 1
      command tread ls "\${@:2}" --emit "$__f"
      local __c=$?
      [ -s "$__f" ] && eval "$(cat "$__f")"
      rm -f "$__f"
      return $__c ;;
    *)
      command tread "$@" ;;
  esac
}
export TREAD_SHELL=${shell}
`;
}

const FISH = `# tread shell integration — tread init fish | source
function tread
  switch $argv[1]
    case use deactivate
      set -l __o (command tread _export $argv | string collect)
      or return $status
      echo $__o | source
    case ls
      set -l __f (mktemp -t tread)
      command tread ls $argv[2..] --emit $__f
      set -l __c $status
      if test -s $__f
        source $__f
      end
      rm -f $__f
      return $__c
    case '*'
      command tread $argv
  end
end
set -gx TREAD_SHELL fish
`;

const STARSHIP = `# add to ~/.config/starship.toml
[env_var.tread]
variable = 'TREAD_ENV'
format   = '[  $env_value ]($style)'
style    = 'bold fg:255 bg:99'
disabled = false

# then place \${env_var.tread} in your top-level format, e.g.
# format = '\${env_var.tread}$directory$git_branch$character'
`;

export function initSnippet(target: string): string {
  switch (target) {
    case "zsh":
    case "bash":
      return posix(target);
    case "fish":
      return FISH;
    case "starship":
      return STARSHIP;
    default:
      throw new Error(
        `unknown shell "${target}"\n\n  supported: zsh, bash, fish, starship`,
      );
  }
}

/** Where `tread init <target> --write` appends. */
export function rcFile(target: string): string {
  const home = os.homedir();
  switch (target) {
    case "zsh": return path.join(home, ".zshrc");
    case "bash": return path.join(home, ".bashrc");
    case "fish": return path.join(home, ".config/fish/config.fish");
    case "starship": return path.join(home, ".config/starship.toml");
    default: throw new Error(`unknown shell "${target}"`);
  }
}

const MARK = "# >>> tread >>>";
const MARK_END = "# <<< tread <<<";

/** Append the integration to the shell rc, or report it is already there. */
export function writeInit(target: string): { file: string; changed: boolean } {
  const file = rcFile(target);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(MARK)) return { file, changed: false };

  const line =
    target === "starship"
      ? initSnippet("starship")
      : target === "fish"
        ? "tread init fish | source\n"
        : `eval "$(tread init ${target})"\n`;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${sep}\n${MARK}\n${line}${MARK_END}\n`);
  return { file, changed: true };
}

/** Single-quote a value for POSIX shells and fish alike. */
function q(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`;
}

function isFish(): boolean {
  return process.env.TREAD_SHELL === "fish";
}

export function exportLines(name: string): string {
  const dir = requireEnv(name);
  // re-sync on every activation: shims can go stale after an agent updates,
  // and anything added to the real home since last time should show up
  ensureSkeleton(dir);
  touchLastUsed(name);
  writeShims();
  const vars: Record<string, string> = { TREAD_ENV: name, ...activationEnv(dir) };
  const lines = Object.entries(vars).map(([k, v]) =>
    isFish() ? `set -gx ${k} ${q(v)}` : `export ${k}=${q(v)}`,
  );
  // shims give the agents their HOME; putting them first is what makes
  // typing `claude` land in the environment
  const shims = shimsDir();
  lines.push(
    isFish()
      ? `set -gx TREAD_PATH_ENTRY ${q(shims)}\nfish_add_path -gm ${q(shims)}`
      : `export TREAD_PATH_ENTRY=${q(shims)}\ncase ":$PATH:" in *:${shims}:*) ;; *) export PATH=${q(shims)}:"$PATH" ;; esac`,
  );
  return lines.join("\n") + "\n";
}

export function deactivateLines(): string {
  const keys = ["TREAD_ENV", ...Object.keys(activationEnv("/")), "TREAD_PATH_ENTRY"];
  const shims = shimsDir();
  const dropPath = isFish()
    ? `set -gx PATH (string match -v ${q(shims)} $PATH)`
    : `export PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${q(shims)} | paste -sd: -)`;
  return (
    [dropPath, ...keys.map((k) => (isFish() ? `set -e ${k}` : `unset ${k}`))].join("\n") +
    "\n"
  );
}

export function shellLoaded(): boolean {
  return Boolean(process.env.TREAD_SHELL);
}
