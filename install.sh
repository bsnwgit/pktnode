#!/bin/bash
# pktNode install script — Ubuntu Server 22.04/24.04 LTS
# Usage: bash install.sh
# Prompts for the install directory (default /opt/pktnode) and port (default
# 8764) when run interactively.
# Override defaults with env vars to skip the prompts, e.g.:
#   PKTNODE_INSTALL_DIR=/opt/pktnode PKTNODE_SERVICE_USER=pktnode PKTNODE_PORT=8764 bash install.sh

set -euo pipefail

if [ -z "${PKTNODE_INSTALL_DIR:-}" ] && [ -t 0 ]; then
    read -rp "Install directory [/opt/pktnode]: " INSTALL_DIR_INPUT
    INSTALL_DIR="${INSTALL_DIR_INPUT:-/opt/pktnode}"
else
    INSTALL_DIR="${PKTNODE_INSTALL_DIR:-/opt/pktnode}"
fi
if [ -z "${PKTNODE_PORT:-}" ] && [ -t 0 ]; then
    read -rp "Port [8764]: " PORT_INPUT
    PORT="${PORT_INPUT:-8764}"
else
    PORT="${PKTNODE_PORT:-8764}"
fi
LOG_DIR="${PKTNODE_LOG_DIR:-$INSTALL_DIR/logs}"
SERVICE_USER="${PKTNODE_SERVICE_USER:-$(whoami)}"
SERVICE_GROUP="${PKTNODE_SERVICE_GROUP:-$SERVICE_USER}"
VENV="$INSTALL_DIR/venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR"
LOCAL_IP="$(hostname -I | awk '{print $1}')"

echo "=== pktNode Installer ==="
echo "Install dir: $INSTALL_DIR"
echo "Service user: $SERVICE_USER"
echo "Port: $PORT"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/9] Installing system packages..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    libssl-dev libffi-dev \
    libxmlsec1-dev libxmlsec1-openssl libxml2-dev pkg-config gcc \
    curl ca-certificates

# ── 2. Create install + log directories ──────────────────────────────────────
echo "[2/9] Creating directories..."
sudo mkdir -p "$INSTALL_DIR"
sudo mkdir -p "$LOG_DIR"
# Owned by the invoking user for now so the steps below don't need sudo;
# re-owned to $SERVICE_USER:$SERVICE_GROUP at the end (step 9).
sudo chown "$(whoami):$(whoami)" "$INSTALL_DIR" "$LOG_DIR"

# ── 3. Python virtualenv ───────────────────────────────────────────────────────
echo "[3/9] Setting up Python virtualenv..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REPO_DIR/requirements.txt"
echo "  Python dependencies installed."

# ── 4. Copy application files ─────────────────────────────────────────────────
echo "[4/9] Copying application files..."
if [ "$REPO_DIR" = "$INSTALL_DIR" ]; then
    echo "  Install dir is the repo checkout itself — nothing to copy."
else
    cp -r "$REPO_DIR/app"        "$INSTALL_DIR/"
    cp -r "$REPO_DIR/migrations" "$INSTALL_DIR/"
    cp -r "$REPO_DIR/docs"       "$INSTALL_DIR/"
fi

# ── 5. Configure ──────────────────────────────────────────────────────────────
echo "[5/9] Setting up config..."
if [ ! -f "$INSTALL_DIR/config.yaml" ]; then
    cp "$REPO_DIR/config.example.yaml" "$INSTALL_DIR/config.yaml"
    # Generate a random secret key
    SECRET=$(openssl rand -hex 32)
    sed -i "s/CHANGE_ME_generate_with_openssl_rand_hex_32/$SECRET/" "$INSTALL_DIR/config.yaml"
    sed -i "s#http://SERVER-IP:8764#http://$LOCAL_IP:$PORT#g" "$INSTALL_DIR/config.yaml"
    sed -i "s/^port: 8764/port: $PORT/" "$INSTALL_DIR/config.yaml"
    # Pin install_dir explicitly (app/config.py derives every other path —
    # db, logs, ssl, backups — from this by default).
    echo "install_dir: \"$INSTALL_DIR\"" >> "$INSTALL_DIR/config.yaml"
    echo "  Config created at $INSTALL_DIR/config.yaml"
    echo "  !! Review and update cors_origins before production use !!"
else
    echo "  Config already exists — skipping."
fi

# ── 6. Apply migrations + create admin user ───────────────────────────────────
echo "[6/9] Initializing database and admin user..."
ADMIN_PASS=$(openssl rand -base64 12 | tr -d '/+=' | head -c 16)

PKTNODE_CONFIG="$INSTALL_DIR/config.yaml" \
PKTNODE_INSTALL_DIR="$INSTALL_DIR" \
PKTNODE_ADMIN_PASSWORD="$ADMIN_PASS" \
"$VENV/bin/python3" - << PYEOF
import asyncio, sys
sys.path.insert(0, '$INSTALL_DIR')

from app.database import init_db, seed_admin

async def setup():
    await init_db()
    await seed_admin()
    print("  Database initialized.")

asyncio.run(setup())
PYEOF

# ── 7. Build frontend ─────────────────────────────────────────────────────────
# Not installing Node.js itself here (see README Requirements — version
# management is left to the operator), but if it's already present, just
# build it — there's no reason to leave this as a manual step when we can.
echo "[7/9] Building frontend..."
FRONTEND_BUILT=0
if command -v npm &>/dev/null; then
    ( cd "$REPO_DIR/frontend" && npm install --no-audit --no-fund && npm run build )
    mkdir -p "$INSTALL_DIR/frontend"
    if [ "$REPO_DIR/frontend/dist" != "$INSTALL_DIR/frontend/dist" ]; then
        rm -rf "$INSTALL_DIR/frontend/dist"
        cp -r "$REPO_DIR/frontend/dist" "$INSTALL_DIR/frontend/dist"
    fi
    FRONTEND_BUILT=1
    echo "  Frontend built and deployed."
else
    echo "  npm not found — skipping (Node.js is required; see README Requirements)."
    echo "  The web UI will return \"Not Found\" until you build it manually — see the"
    echo "  banner at the end of this script for the exact commands."
fi

# ── 8. Build agent binaries ───────────────────────────────────────────────────
# Served from /agent-releases by the server itself — Settings → Enrollment's
# install command downloads straight from there. Requires Go; if it's not
# present, enrollment still works to create tokens, but the one-line install
# commands won't have a binary to fetch until this is built manually.
echo "[8/9] Building agent binaries..."
AGENT_BUILT=0
if command -v go &>/dev/null; then
    ( cd "$REPO_DIR/agent" && ./build.sh )
    if [ "$REPO_DIR/agent-releases" != "$INSTALL_DIR/agent-releases" ]; then
        rm -rf "$INSTALL_DIR/agent-releases"
        cp -r "$REPO_DIR/agent-releases" "$INSTALL_DIR/agent-releases"
    fi
    AGENT_BUILT=1
    echo "  Agent binaries built and deployed."
else
    echo "  go not found — skipping (Go is required to build the agent; see README Requirements)."
    echo "  Enrollment tokens can still be created, but the install command won't have"
    echo "  a binary to download until you build it manually — see the banner below."
fi

# ── 9. Install systemd service ────────────────────────────────────────────────
echo "[9/9] Installing systemd service..."
# Re-own the install/log dirs to the service user before starting the service.
sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR" "$LOG_DIR"
sed \
    -e "s#__INSTALL_DIR__#$INSTALL_DIR#g" \
    -e "s#__LOG_DIR__#$LOG_DIR#g" \
    -e "s#__SERVICE_USER__#$SERVICE_USER#g" \
    -e "s#__SERVICE_GROUP__#$SERVICE_GROUP#g" \
    "$REPO_DIR/pktnode.service" | sudo tee /etc/systemd/system/pktnode.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable pktnode
sudo systemctl start pktnode

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║             pktNode installed successfully!                ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  URL:           http://%-35s║\n" "$LOCAL_IP:$PORT"
echo "║  Username:      admin                                    ║"
printf "║  Password:      %-43s║\n" "$ADMIN_PASS"
echo "║                                                          ║"
echo "║  SAVE THESE CREDENTIALS — they won't be shown again!     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
if [ "$FRONTEND_BUILT" -eq 0 ]; then
    echo "!! Frontend was NOT built (npm not found) — the web UI will show"
    echo "!! {\"detail\":\"Not Found\"} until you run:"
    echo "!!   cd $REPO_DIR/frontend && npm install && npm run build"
    if [ "$REPO_DIR/frontend/dist" != "$INSTALL_DIR/frontend/dist" ]; then
        echo "!!   mkdir -p $INSTALL_DIR/frontend && cp -r $REPO_DIR/frontend/dist $INSTALL_DIR/frontend/dist"
    fi
    echo "!!   sudo systemctl restart pktnode"
    echo ""
fi
if [ "$AGENT_BUILT" -eq 0 ]; then
    echo "!! Agent binaries were NOT built (go not found) — install commands under"
    echo "!! Settings → Enrollment won't have a binary to download until you run:"
    echo "!!   cd $REPO_DIR/agent && ./build.sh"
    if [ "$REPO_DIR/agent-releases" != "$INSTALL_DIR/agent-releases" ]; then
        echo "!!   cp -r $REPO_DIR/agent-releases $INSTALL_DIR/agent-releases"
    fi
    echo "!!   sudo systemctl restart pktnode"
    echo ""
fi
echo "Next steps:"
echo "  1. Open the firewall for TCP $PORT"
echo "  2. Log in and change the admin password in Settings → Users"
echo "  3. Create an enrollment token in Enrollment (top-level nav) and install the"
echo "     agent on your first managed endpoint"
