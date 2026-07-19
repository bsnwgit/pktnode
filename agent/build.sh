#!/usr/bin/env bash
# Cross-compiles the pktNode agent (and, best-effort, the tray status
# helper) for every supported OS/arch and drops the binaries in
# ../agent-releases, where the server serves them for the
# install-agent.sh/.ps1 installer scripts to download.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OUT_DIR="../agent-releases"
mkdir -p "$OUT_DIR"

agent_targets=(
  "darwin amd64 pktnode-agent-darwin-amd64"
  "darwin arm64 pktnode-agent-darwin-arm64"
  "linux amd64 pktnode-agent-linux-amd64"
  "linux arm64 pktnode-agent-linux-arm64"
  "windows amd64 pktnode-agent-windows-amd64.exe"
  "windows arm64 pktnode-agent-windows-arm64.exe"
)

for target in "${agent_targets[@]}"; do
  read -r goos goarch name <<< "$target"
  echo "Building $name ($goos/$goarch)..."
  GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/$name" .
done

# ── Tray status helper (cgo — best-effort, not every host has the
#    toolchain for every target) ───────────────────────────────────────────
# darwin: builds natively with the system's Clang, both arches.
# windows/amd64: needs a mingw-w64 cross-compiler (`brew install mingw-w64`
#   on macOS); falls back to a warning, not a hard failure, if absent.
# windows/arm64: no widely-available cgo cross-toolchain — skipped.
# linux: needs GTK3 + libappindicator3 dev headers for the target arch,
#   impractical to cross-compile from another OS — build this one
#   natively on a Linux box with those packages installed, if you want it.
echo ""
echo "Building tray status helper (best-effort per platform)..."

build_tray() {
  local goos="$1" goarch="$2" name="$3"; shift 3
  if CGO_ENABLED=1 GOOS="$goos" GOARCH="$goarch" "$@" go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/$name" ./cmd/pktnode-tray 2>/tmp/pktnode-tray-build.log; then
    echo "  built $name"
  else
    echo "  SKIPPED $name (no cgo toolchain for this target — see $OUT_DIR/$name.skipped.log)"
    cp /tmp/pktnode-tray-build.log "$OUT_DIR/$name.skipped.log"
  fi
}

build_tray darwin amd64 pktnode-tray-darwin-amd64
build_tray darwin arm64 pktnode-tray-darwin-arm64
if command -v x86_64-w64-mingw32-gcc &>/dev/null; then
  build_tray windows amd64 pktnode-tray-windows-amd64.exe env CC=x86_64-w64-mingw32-gcc
else
  echo "  SKIPPED pktnode-tray-windows-amd64.exe (mingw-w64 not installed — 'brew install mingw-w64')"
fi
echo "  SKIPPED pktnode-tray-windows-arm64.exe (no arm64 mingw-w64 cross-toolchain available)"
echo "  SKIPPED pktnode-tray-linux-* (build natively on Linux with GTK3 + libappindicator3-dev)"

echo ""
echo "Done. Binaries in $OUT_DIR:"
ls -la "$OUT_DIR"
