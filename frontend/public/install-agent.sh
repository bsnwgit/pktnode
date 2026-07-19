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

binary="pktnode-agent-${os}-${arch}"
url="${SERVER%/}/agent-releases/${binary}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Downloading $binary from $SERVER..."
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"

echo "Installing pktNode agent..."
"$tmp" install --server "$SERVER" --token "$TOKEN"

echo "Done."
