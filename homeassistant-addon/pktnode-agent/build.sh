#!/usr/bin/env bash
# Cross-compiles the same pktnode-agent binary used for native Linux
# installs (amd64 only for now — see config.yaml's `arch` list) and drops
# it alongside the Dockerfile. It's the identical program either way —
# `pktnode-agent run` detects inventory.IsHAOS() (SUPERVISOR_TOKEN being
# set) at startup and switches to the Supervisor-API-backed loop instead
# of the native systemd/launchd/SCM one. See agent/internal/haosloop.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

AGENT_DIR="../../agent"
OUT="pktnode-agent"

# Same shared version identity as every other platform build (agent/build.sh
# extracts the same constant) — keeps config.yaml's manifest version from
# silently drifting out of sync with what the binary actually reports.
AGENT_VERSION="$(sed -nE 's/^const AgentVersion = "(.*)"$/\1/p' "$AGENT_DIR/internal/inventory/inventory.go")"
if [ -z "$AGENT_VERSION" ]; then
  echo "Could not extract AgentVersion from $AGENT_DIR/internal/inventory/inventory.go" >&2
  exit 1
fi
echo "Agent version: $AGENT_VERSION"
sed -i.bak -E "s/^version: \".*\"$/version: \"$AGENT_VERSION\"/" config.yaml && rm -f config.yaml.bak

echo "Building $OUT (linux/amd64)..."
(cd "$AGENT_DIR" && GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$(pwd)/../homeassistant-addon/pktnode-agent/$OUT" .)

echo "Done: $OUT (config.yaml version synced to $AGENT_VERSION)"
