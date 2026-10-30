#!/bin/sh
# Builds simgate from this checkout into one self-contained binary at
# $SIMGATE_BIN_DIR (default ~/.local/bin/simgate). `simgate update` runs it again
# after pulling. Needs Bun (the version in mise.toml; through mise when present).
set -eu
cd "$(dirname "$0")"
source_dir=$(pwd)
bin_dir=${SIMGATE_BIN_DIR:-$HOME/.local/bin}
version=$(git describe --always --dirty 2>/dev/null || echo unknown)

run_bun() {
  if command -v mise >/dev/null 2>&1; then mise exec -- bun "$@"; else bun "$@"; fi
}

mkdir -p "$bin_dir"
run_bun install --frozen-lockfile
run_bun build --compile src/cli.ts --outfile "$bin_dir/simgate.new" \
  --define "SIMGATE_VERSION=\"$version\"" --define "SIMGATE_SOURCE=\"$source_dir\""
# Bun's compiled binary carries the linker's ad-hoc signature over code it appended
# afterwards, which macOS kills on launch (SIGKILL, invalid signature): sign it again.
if [ "$(uname -s)" = Darwin ]; then codesign --force --sign - "$bin_dir/simgate.new"; fi
# Replace the binary in one step, so a session starting meanwhile never runs half a file.
mv "$bin_dir/simgate.new" "$bin_dir/simgate"
"$bin_dir/simgate" version
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "simgate: add $bin_dir to PATH for every shell agents use (fish, zsh, bash -lc)." >&2 ;;
esac
