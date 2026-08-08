#!/bin/sh
# tread installer
#
#   curl -fsSL https://raw.githubusercontent.com/Hanyang-Li/tread/main/install.sh | sh
#
# Environment:
#   VERSION=v0.2.0        install a specific release (default: latest)
#   INSTALL_DIR=/path     where the binary goes (default: ~/.local/bin)
#   NO_MODIFY_PATH=1      never touch a shell rc; print the manual steps instead
set -eu

REPO="Hanyang-Li/tread"
BIN="tread"
TARGET="aarch64-apple-darwin"
ASSET="$BIN-$TARGET.tar.gz"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

info() {
  printf '\033[1;32m✔\033[0m %s\n' "$1"
}

fail() {
  printf '\033[1;31m✘\033[0m %s\n' "$1" >&2
  exit 1
}

# Fallback when we will not (or cannot) edit a shell rc.
path_hint() {
  printf 'add %s to your PATH:\n' "$INSTALL_DIR"
  printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
}

# Put $INSTALL_DIR on PATH, idempotently, via the user's shell rc.
ensure_on_path() {
  marker="# added by tread installer (PATH)"
  case "$(basename "${SHELL:-}")" in
    zsh)  rc="$HOME/.zshrc";                   line="export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
    bash) rc="$HOME/.bashrc";                  line="export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path ${INSTALL_DIR}" ;;
    *)    path_hint; return ;;
  esac

  if [ -f "$rc" ] && grep -qF "$marker" "$rc" 2>/dev/null; then
    info "PATH already configured ($rc)"
    return
  fi

  mkdir -p "$(dirname "$rc")" 2>/dev/null || true
  if ! { printf '\n%s\n%s\n' "$marker" "$line" >> "$rc"; } 2>/dev/null; then
    path_hint
    return
  fi

  info "added ${INSTALL_DIR} to PATH ($rc)"
}

# --- environment checks ---
[ "$(uname -s)" = "Darwin" ] || fail "macOS only"
[ "$(uname -m)" = "arm64" ] || fail "Apple Silicon (M-series) only"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v shasum >/dev/null 2>&1 || fail "shasum is required"

# --- resolve the version and the download URL ---
if [ -n "${VERSION:-}" ]; then
  tag="$VERSION"
else
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$tag" ] || fail "could not resolve the latest version; retry with VERSION=v0.2.0"

base="https://github.com/$REPO/releases/download/$tag"

# --- download into a temp dir, cleaned up on exit ---
tmp=$(mktemp -d)
SUDO=""
STAGE=""
cleanup() {
  rm -rf "$tmp"
  [ -n "$STAGE" ] && $SUDO rm -f "$STAGE" 2>/dev/null
  return 0
}
trap cleanup EXIT

printf 'downloading %s\n' "$base/$ASSET"
curl -fsSL --proto '=https' "$base/$ASSET" -o "$tmp/$ASSET" || fail "download failed: $base/$ASSET"
curl -fsSL --proto '=https' "$base/$ASSET.sha256" -o "$tmp/$ASSET.sha256" || fail "download failed: $base/$ASSET.sha256"

# --- verify ---
printf 'verifying checksum\n'
( cd "$tmp" && shasum -a 256 -c "$ASSET.sha256" >/dev/null ) || fail "checksum mismatch"

tar -xzf "$tmp/$ASSET" -C "$tmp" || fail "could not unpack $ASSET"
[ -f "$tmp/$BIN" ] || fail "$BIN missing from the archive"

# --- elevate only if the target directory is not writable ---
# The default ~/.local/bin is under $HOME and needs no sudo; only an override
# like INSTALL_DIR=/usr/local/bin does.
mkdir -p "$INSTALL_DIR" 2>/dev/null || true
if [ -d "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ]; then
  SUDO=""
else
  printf 'installing into %s needs administrator rights\n' "$INSTALL_DIR"
  SUDO="sudo"
  $SUDO mkdir -p "$INSTALL_DIR"
fi

# --- install by rename inside the target directory ---
# Staging inside $INSTALL_DIR keeps the final mv a same-filesystem rename(2):
# it swaps the directory entry without opening or truncating the target, so it
# can replace a running binary without ETXTBSY. A cross-device mv would fall
# back to copy-and-truncate.
STAGE="$INSTALL_DIR/.$BIN.tmp.$$"
$SUDO cp "$tmp/$BIN" "$STAGE" || fail "could not stage the binary in $INSTALL_DIR"
$SUDO chmod 0755 "$STAGE"
$SUDO mv "$STAGE" "$INSTALL_DIR/$BIN" || fail "could not install the binary into $INSTALL_DIR"
STAGE=""

info "installed $BIN $tag to $INSTALL_DIR/$BIN"

# --- shell integration ---
# `use` and `deactivate` change the calling shell's environment, so tread needs
# a shell function; a child process cannot do it. `init <shell> --write` appends
# a marked block to the rc and, for zsh, writes the tab completion.
shell_name="$(basename "${SHELL:-}")"
if [ -n "${NO_MODIFY_PATH:-}" ]; then
  printf '\nskipping shell setup (NO_MODIFY_PATH). to finish by hand:\n'
  path_hint
  printf '  %s/%s init zsh --write\n' "$INSTALL_DIR" "$BIN"
  exit 0
fi

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) : ;;
  *) ensure_on_path ;;
esac

case "$shell_name" in
  zsh|bash|fish) "$INSTALL_DIR/$BIN" init "$shell_name" --write ;;
  *)
    printf 'unknown shell "%s" — install the integration yourself:\n' "$shell_name"
    printf '  %s/%s init zsh --write\n' "$INSTALL_DIR" "$BIN"
    ;;
esac

info "done. open a new terminal, or: source ~/.zshrc"
