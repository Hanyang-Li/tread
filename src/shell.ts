import { activationEnv } from "./paths.ts";
import { requireEnv, touchLastUsed } from "./env.ts";

/**
 * `use` and `deactivate` must mutate the caller's shell, so they are eval'd.
 * `ls` can activate too, but it is a TUI: it renders on the terminal and
 * writes the export lines to the --emit file, which the wrapper then evals.
 * `show` is read-only and needs neither.
 */
function posix(shell: string): string {
  return `# tread shell integration — eval "$(tread init ${shell})"
tread() {
  case "$1" in
    use|deactivate)
      eval "$(command tread _export "$@")" ;;
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
      command tread _export $argv | source
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

/** Single-quote a value for POSIX shells and fish alike. */
function q(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`;
}

function isFish(): boolean {
  return process.env.TREAD_SHELL === "fish";
}

export function exportLines(name: string): string {
  const dir = requireEnv(name);
  touchLastUsed(name);
  const vars: Record<string, string> = { TREAD_ENV: name, ...activationEnv(dir) };
  return (
    Object.entries(vars)
      .map(([k, v]) => (isFish() ? `set -gx ${k} ${q(v)}` : `export ${k}=${q(v)}`))
      .join("\n") + "\n"
  );
}

export function deactivateLines(): string {
  const keys = ["TREAD_ENV", ...Object.keys(activationEnv("/"))];
  return (
    keys.map((k) => (isFish() ? `set -e ${k}` : `unset ${k}`)).join("\n") + "\n"
  );
}

export function shellLoaded(): boolean {
  return Boolean(process.env.TREAD_SHELL);
}
