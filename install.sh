#!/usr/bin/env bash
# Compile tread into a single self-contained binary. No runtime dependencies:
# the binary does not need bun, node or any vendored CLI at run time.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${TREAD_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"

echo "==> compiling tread -> $BIN_DIR/tread"
# BUN_NO_CODESIGN_MACHO_BINARY works around the bun 1.3.12 regression where
# --compile emits a corrupt signature and macOS then SIGKILLs the binary.
BUN_NO_CODESIGN_MACHO_BINARY=1 bun build --compile --minify \
  "$REPO_DIR/src/index.ts" --outfile "$BIN_DIR/tread"

# macOS arm64 kills unsigned binaries; ad-hoc sign the output.
if [ "$(uname)" = "Darwin" ] && command -v codesign >/dev/null; then
  codesign --sign - --force "$BIN_DIR/tread"
fi

echo "==> done"
echo
echo "  tread: $BIN_DIR/tread   (make sure $BIN_DIR is on your PATH)"
echo
echo "  install the shell integration, then restart your shell:"
echo "      tread init zsh --write"
echo
echo "  that appends the eval line to ~/.zshrc and installs the tab completion."
