#!/usr/bin/env bash
# Cross-compiles the pktNode agent for every supported OS/arch and drops
# the binaries in ../agent-releases, where the server serves them for the
# install-agent.sh/.ps1 installer scripts to download.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OUT_DIR="../agent-releases"
mkdir -p "$OUT_DIR"

targets=(
  "darwin amd64 pktnode-agent-darwin-amd64"
  "darwin arm64 pktnode-agent-darwin-arm64"
  "linux amd64 pktnode-agent-linux-amd64"
  "linux arm64 pktnode-agent-linux-arm64"
  "windows amd64 pktnode-agent-windows-amd64.exe"
  "windows arm64 pktnode-agent-windows-arm64.exe"
)

for target in "${targets[@]}"; do
  read -r goos goarch name <<< "$target"
  echo "Building $name ($goos/$goarch)..."
  GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/$name" .
done

echo "Done. Binaries in $OUT_DIR:"
ls -la "$OUT_DIR"
