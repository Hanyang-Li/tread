#!/usr/bin/env bash
# Install tread: compile the binary to ~/.local/bin and vendor runtime
# dependencies (the `skills` CLI) into ~/.local/share/tread.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
SHARE_DIR="${TREAD_SHARE_DIR:-$HOME/.local/share/tread}"

mkdir -p "$BIN_DIR" "$SHARE_DIR"

echo "==> compiling tread → $BIN_DIR/tread"
# BUN_NO_CODESIGN_MACHO_BINARY works around the bun 1.3.12 regression where
# --compile emits a corrupt signature (macOS then SIGKILLs the binary).
BUN_NO_CODESIGN_MACHO_BINARY=1 bun build --compile --minify "$REPO_DIR/src/index.ts" --outfile "$BIN_DIR/tread"

# macOS arm64 kills unsigned binaries (SIGKILL); ad-hoc sign the output.
if [ "$(uname)" = "Darwin" ] && command -v codesign >/dev/null; then
  codesign --sign - --force "$BIN_DIR/tread"
fi

echo "==> vendoring skills CLI → $SHARE_DIR"
if [ ! -f "$SHARE_DIR/package.json" ]; then
  cat > "$SHARE_DIR/package.json" <<'EOF'
{
  "name": "tread-shared-deps",
  "private": true,
  "dependencies": {}
}
EOF
fi
cd "$SHARE_DIR"
bun add skills

echo "==> done"
echo "tread: $BIN_DIR/tread (make sure $BIN_DIR is on your PATH)"
