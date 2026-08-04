#!/usr/bin/env bash
# pktNode agent — Home Assistant OS add-on installer
# Run this from Home Assistant's SSH & Web Terminal add-on:
#   curl -fsSL <server>/install-haos-addon.sh | bash -s -- --server <server>
#
# Home Assistant OS doesn't allow installing arbitrary software directly —
# the only supported path is a proper Supervisor Add-on. This stages one as
# a "local add-on" (Settings -> Add-ons -> Add-on Store -> Local add-ons),
# same as any add-on you'd write yourself; it does NOT install/start it —
# that's still a couple of clicks in the HA UI, since only the Supervisor
# itself is allowed to build and launch add-on containers.
set -euo pipefail

SERVER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$SERVER" ]]; then
  echo "Usage: install-haos-addon.sh --server <url>" >&2
  exit 1
fi

ADDON_DIR=/addons/local/pktnode-agent

if [[ "$(id -u)" -ne 0 ]]; then
  sudo mkdir -p "$ADDON_DIR"
  sudo chown "$(id -u):$(id -g)" "$ADDON_DIR"
else
  mkdir -p "$ADDON_DIR"
fi

echo "Staging add-on files in $ADDON_DIR ..."

cat > "$ADDON_DIR/config.yaml" << 'CONFIG_EOF'
name: pktNode Agent
version: "0.8.0"
slug: pktnode_agent
description: Reports this Home Assistant instance to a pktNode server for monitoring and remote host control.
url: "https://github.com/bsnwgit/pktnode"
arch:
  - amd64
init: false
hassio_api: true
hassio_role: manager
homeassistant_api: false
host_network: false
options:
  server_url: ""
  enrollment_token: ""
schema:
  server_url: url
  enrollment_token: password
CONFIG_EOF

cat > "$ADDON_DIR/build.yaml" << 'BUILD_EOF'
build_from:
  amd64: "ghcr.io/home-assistant/amd64-base:3.20"
BUILD_EOF

cat > "$ADDON_DIR/Dockerfile" << 'DOCKERFILE_EOF'
ARG BUILD_FROM
FROM $BUILD_FROM

# The exact same pktnode-agent binary every other platform build uses —
# pre-built for the target arch (see build.sh in this folder) rather than
# compiled inside this image, simpler than wiring up a Go toolchain stage
# for what's currently a single-arch (amd64) add-on.
COPY pktnode-agent /usr/bin/pktnode-agent
RUN chmod a+x /usr/bin/pktnode-agent

# run.sh (not a bare CMD pointing at the binary directly) — see its own
# comment for why: the base image's S6-overlay init strips the container
# environment, SUPERVISOR_TOKEN included, from anything launched without
# `with-contenv`.
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
DOCKERFILE_EOF

cat > "$ADDON_DIR/run.sh" << 'RUN_EOF'
#!/usr/bin/with-contenv bashio
# The base image's S6-overlay init strips the container's environment
# (SUPERVISOR_TOKEN included) from anything launched as a bare Dockerfile
# CMD — `with-contenv` is S6's own mechanism for restoring it. Without
# this, the token exists in the container but never reaches the process.
exec /usr/bin/pktnode-agent run
RUN_EOF
chmod +x "$ADDON_DIR/run.sh"

echo "Downloading pktnode-agent (linux/amd64)..."
curl -fsSL "${SERVER%/}/agent-releases/pktnode-agent-linux-amd64" -o "$ADDON_DIR/pktnode-agent"
chmod +x "$ADDON_DIR/pktnode-agent"

echo ""
echo "Done. In Home Assistant:"
echo "  1. Settings -> Add-ons -> Add-on Store -> (top-right menu) -> Check for updates"
echo "  2. Find 'pktNode Agent' under Local add-ons -> Install"
echo "  3. Configuration tab: set Server URL and Enrollment Token (from ${SERVER%/}, Settings -> Enrollment)"
echo "  4. Start the add-on and check its Log tab"
