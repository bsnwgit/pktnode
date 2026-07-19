#!/usr/bin/env bash
# pktNode agent installer — macOS / Linux
# Usage: curl -fsSL <server>/install-agent.sh | sudo bash -s -- --server <server> --token <enrollment-token>
set -euo pipefail

SERVER=""
TOKEN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token)  TOKEN="$2";  shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$SERVER" || -z "$TOKEN" ]]; then
  echo "Usage: install-agent.sh --server <url> --token <enrollment-token>" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This installer must run as root — re-run with sudo." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

binary="pktnode-agent-${os}-${arch}"
url="${SERVER%/}/agent-releases/${binary}"
echo "Downloading $binary from $SERVER..."
curl -fsSL "$url" -o "$tmpdir/pktnode-agent"
chmod +x "$tmpdir/pktnode-agent"

# Tray status icon — best-effort, not every OS/arch has one built (see
# agent/build.sh). Named as a fixed sibling filename so the agent binary
# can find it regardless of which OS/arch build it came from.
tray_binary="pktnode-tray-${os}-${arch}"
if curl -fsSL "${SERVER%/}/agent-releases/${tray_binary}" -o "$tmpdir/pktnode-tray" 2>/dev/null; then
  chmod +x "$tmpdir/pktnode-tray"
  echo "Downloaded status icon helper."
fi

echo "Installing pktNode agent..."
"$tmpdir/pktnode-agent" install --server "$SERVER" --token "$TOKEN"

echo "Done."
