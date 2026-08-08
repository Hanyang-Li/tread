import fs from "node:fs";
import path from "node:path";
import { activationEnv, completionFile, dataDir, realHome, shimsDir } from "./paths.ts";
import { ensureSkeleton, requireEnv, touchLastUsed } from "./env.ts";
import { writeShims } from "./shims.ts";

/** Everything `tread init` takes. The completion asks for this list by name. */
export const SHELLS = ["zsh", "bash", "fish", "starship"] as const;

/**
 * Wire the completion into zsh — if it is there.
 *
 * Three guards, one for each way this goes wrong. `-r`: the file is written by
 * `init zsh --write`, and someone who added the eval line by hand has never run
 * it, so compdef would register a function that does not exist and the first
 * TAB would fail. `${fpath:#…}`: a nested shell or a doubly-sourced rc would
 * otherwise grow fpath without bound — dropping the entry before prepending it
 * makes the block idempotent. `$+functions[compdef]`: compdef only exists once
 * compinit has run, and the eval line may well come first; in that order the
 * fpath entry alone is enough, because compinit picks it up itself.
 */
function zshCompletion(): string {
  const dir = q(dataDir());
  return `if [[ -r ${q(completionFile())} ]]; then
  fpath=(${dir} \${fpath:#${dir}})
  (( $+functions[compdef] )) && { autoload -Uz _tread && compdef _tread tread }
fi
`;
}

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
${shell === "zsh" ? zshCompletion() : ""}`;
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

const MODULE_REF = "${env_var.tread}";

const STARSHIP_MODULE = `[env_var.tread]
variable = 'TREAD_ENV'
format   = '[ 󰚩 $env_value ]($style)'
style    = 'bold fg:255 bg:99'
disabled = false
`;

const STARSHIP = `# add to ~/.config/starship.toml
${STARSHIP_MODULE}
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
        `unknown shell "${target}"\n\n  supported: ${SHELLS.join(", ")}`,
      );
  }
}

/** Where `tread init <target> --write` appends. */
export function rcFile(target: string): string {
  // an agent shelling out to `tread init --write` has had HOME moved to the
  // env root by its shim; os.homedir() would follow it there and the
  // integration would land in the environment's rc file instead of the
  // user's real one
  const home = realHome();
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

export type StarshipEdit =
  | { kind: "spliced"; text: string }
  | { kind: "present" }
  | { kind: "default" }
  | { kind: "manual" };

const OPEN_FORMAT = /^[ \t]*format[ \t]*=[ \t]*("""|'''|"|')/;
const OPEN_MULTILINE = /=[ \t]*("""|''')/;

/** Offset just past the opening quote of the top-level `format`, if it has one. */
function topLevelFormat(toml: string): { delim: string; at: number } | null {
  let at = 0;
  let inside: string | null = null;
  for (const line of toml.split("\n")) {
    if (inside) {
      if (line.includes(inside)) inside = null;
    } else {
      const t = line.trimStart();
      // the first table header ends the top level; a module's own `format` is
      // not the one starship renders the prompt from
      if (t.startsWith("[")) return null;
      if (!t.startsWith("#")) {
        const f = OPEN_FORMAT.exec(line);
        if (f) return { delim: f[1]!, at: at + f[0].length };
        // some other key opening a multi-line string: its body may contain
        // lines that look like table headers
        const m = OPEN_MULTILINE.exec(line);
        if (m && !line.slice(m.index + m[0].length).includes(m[1]!)) inside = m[1]!;
      }
    }
    at += line.length + 1;
  }
  return null;
}

/**
 * starship renders only the modules its top-level `format` names, so appending
 * `[env_var.tread]` is not enough: with an explicit format the pill never
 * shows. Configs without one fall back to `$all`, which does cover `env_var.*`.
 */
export function spliceStarshipFormat(toml: string): StarshipEdit {
  const f = topLevelFormat(toml);
  if (!f) return { kind: "default" };

  const rest = toml.slice(f.at);
  const close = rest.indexOf(f.delim);
  if ((close === -1 ? rest : rest.slice(0, close)).includes(MODULE_REF)) {
    return { kind: "present" };
  }

  // a newline right after the opening delimiter is eaten by TOML; keeping that
  // shape means ending our own line with a continuation, which only basic
  // strings have — in a literal string the backslash would reach the prompt
  const wrapped = rest.startsWith("\n");
  if (wrapped && f.delim === "'''") return { kind: "manual" };
  const insert = wrapped ? `\n${MODULE_REF}\\` : MODULE_REF;
  return { kind: "spliced", text: toml.slice(0, f.at) + insert + rest };
}

/** Append the integration to the shell rc, or report it is already there. */
export function writeInit(
  target: string,
): { file: string; changed: boolean; format?: StarshipEdit["kind"] } {
  const file = rcFile(target);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  if (target === "starship") {
    const edit = spliceStarshipFormat(existing);
    const changed = !existing.includes(MARK);
    let text = edit.kind === "spliced" ? edit.text : existing;
    if (changed) {
      const sep = text && !text.endsWith("\n") ? "\n" : "";
      text += `${sep}\n${MARK}\n${STARSHIP_MODULE}${MARK_END}\n`;
    }
    if (changed || edit.kind === "spliced") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return { file, changed, format: edit.kind };
  }

  if (existing.includes(MARK)) return { file, changed: false };
  const line =
    target === "fish"
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
