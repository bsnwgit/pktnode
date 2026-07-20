# pktNode

<p align="center">
  <img src="lockup-256h.png" alt="pktNode" height="64">
</p>

RMM (remote monitoring & management) for the pkt suite — tracks and manages
user-level assets (Mac/Windows/Linux endpoints) via a lightweight Go agent
that enrolls with the server, checks in on an interval reporting hardware/
software inventory and live resource usage, and executes queued remote
actions (service restarts, script execution, reboot/shutdown).

**Default port:** `8764` (HTTP)

---

## Table of Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Agent](#agent)
- [Frontend Build & Deploy](#frontend-build--deploy)
- [Configuration Reference](#configuration-reference)
- [Running & Managing the Service](#running--managing-the-service)
- [Roles & Auth](#roles--auth)
- [Alerting](#alerting)
- [Suite Integration](#suite-integration)
- [Backup & Restore](#backup--restore)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Known Gaps / Fast-Follow Work](#known-gaps--fast-follow-work)

---

## Architecture

- **Server**: FastAPI + SQLite (aiosqlite), same shape as the rest of the
  pkt* suite — `app/main.py` wires routers, `app/database.py` runs
  migrations on startup, `app/config.py` reads `config.yaml`.
- **Frontend**: React + Vite + Tailwind SPA under `frontend/`, served from
  `frontend/dist` by the FastAPI app once built.
- **Agent**: a single static Go binary (`agent/`) — no runtime dependency
  on the target machine. Enrolls once with a shared enrollment token, then
  checks in on an interval (default 60s) over plain HTTPS/HTTP using its
  own per-node bearer token. Runs as a native OS service: launchd on
  macOS, systemd on Linux, a Windows Service via SCM on Windows.

Data flow: agent → `POST /api/agent/checkin` → server updates the node row,
appends a metrics-history sample, and (on a full-inventory check-in, every
15th by default) replaces the software/process/interface snapshots. Any
`commands` rows queued for that node with `status='pending'` are handed
back in the response and flipped to `status='sent'`; the agent executes
each one and reports the result via
`POST /api/agent/commands/{id}/result`.

## Requirements

- Python 3.10+
- Node.js + npm (to build the frontend — see [Frontend Build & Deploy](#frontend-build--deploy))
- Go 1.21+ (to build the agent binaries — see [Agent](#agent)); not needed
  at runtime, only to produce the binaries `install.sh` serves
- Ubuntu Server 22.04/24.04 LTS (install.sh targets apt; adapt for other
  distros)

## Installation

```bash
git clone git@github.com:bsnwgit/pktnode.git
cd pktnode
bash install.sh
```

Prompts for the install directory (default `/opt/pktnode`) and port
(default `8764`). Set `PKTNODE_INSTALL_DIR` / `PKTNODE_PORT` /
`PKTNODE_SERVICE_USER` env vars to skip the prompts for a scripted install.

**Never run `sudo ./install.sh`** — the script calls `sudo` internally for
the steps that need it (apt packages, systemd, re-owning directories to the
service user). Running the whole script as root breaks ownership of the
venv/frontend build.

The installer builds the frontend and the agent binaries automatically if
`npm`/`go` are present on the install machine; if not, it prints the exact
commands to run manually afterward (see the end-of-run banner).

## Agent

### Building

```bash
cd agent
./build.sh
```

Cross-compiles for `darwin/amd64`, `darwin/arm64`, `linux/amd64`,
`linux/arm64`, `windows/amd64`, `windows/arm64` into `../agent-releases/`,
which the server serves at `/agent-releases/<binary-name>` for the
installer scripts to download.

### Enrolling a node

1. In the UI: **Settings → Enrollment** (admin only) → **New Token**.
   Optionally set a label, an expiry, and a max-use count (1 for a
   single-machine install, unlimited for a shared rollout token).
2. Copy the generated install command for the target OS and run it on the
   machine:

   ```bash
   # macOS / Linux
   curl -fsSL http://<server>:8764/install-agent.sh | sudo bash -s -- --server http://<server>:8764 --token <token>
   ```

   ```powershell
   # Windows (elevated PowerShell)
   iwr http://<server>:8764/install-agent.ps1 -UseBasicParsing | iex
   Install-PktNodeAgent -Server "http://<server>:8764" -Token "<token>"
   ```

The installer downloads the matching prebuilt binary, enrolls (exchanging
the enrollment token for a per-node bearer token that's never used again
after this step), installs itself as a native service, and starts checking in.

### Manual agent CLI

```
pktnode-agent install --server <url> --token <enrollment-token>
pktnode-agent uninstall --unlock-code <code>
pktnode-agent unlock <code>
pktnode-agent run        # invoked by the OS service manager; not for direct use
pktnode-agent version
```

### What gets collected

Every check-in: CPU/memory/disk %, uptime, current logged-in user, primary
IP. Every 15th check-in (configurable via the check-in cadence, not
independently): full software inventory, running-process snapshot, and
network interfaces — replaced wholesale each time, not appended to history.

### Remote actions

From a node's detail page, admins/analysts can queue: `restart_service`,
`kill_process`, `run_script` (shell on macOS/Linux, PowerShell on Windows),
`reboot`, `shutdown`. Commands are picked up on the node's next check-in
(so latency is bounded by the check-in interval, not instant) and results
are visible in the node's Commands tab.

### Status icon (tray helper)

A small per-user helper (`agent/cmd/pktnode-tray`) shows agent status
(online/offline, last check-in) in the macOS menu bar or Windows system
tray. It's a *separate* process from the root/SYSTEM agent service —
root/SYSTEM processes can't draw any UI on any of the three OSes, so the
root agent writes a world-readable `status.json` after each check-in and
the tray helper (running in the user's own login session) just reads it;
it has no network access or credentials of its own. Installed
automatically by `install-agent.sh`/`.ps1` when a tray build exists for
the target OS/arch (see `agent/build.sh` — not every target has one; cgo
+ a native GUI toolkit is required, so Linux needs building natively on a
Linux box with GTK3/libappindicator3-dev, and Windows/arm64 has no
readily available cgo cross-toolchain).

**The tray and the agent are tied together, not independent.** There is
no plain "quit the icon" option — the tray's **Stop Agent…** menu item
prompts for the override code (see below) via a native OS dialog
(`osascript`/PowerShell `InputBox`/`zenity`), and only ever *asks* the
privileged agent process to verify it: the tray has no access to the
root-owned secret and can't check a code itself. It drops the entered
code into a shared, deliberately world-writable control file
(`/tmp/pktnode-agent-control` on macOS/Linux, a loosened-ACL subfolder of
`ProgramData\pktNodeAgent` on Windows); the agent polls that file every 2
seconds, verifies the code the same offline way as the CLI, and — only if
valid — asks the real OS service manager to stop itself for real (not
just exit and get relaunched by `Restart=always`/`KeepAlive`). The tray
then waits for the agent's own confirmation that it stopped before it
quits itself, so the icon and the service go away together, not the icon
alone. The same holds in the other direction: however the agent gets
stopped (this flow, or the CLI's `unlock`+service-manager path below),
the tray notices via a `stopped: true` flag in `status.json` on its next
poll and exits itself in lockstep.

### Tamper lockout (override code)

Stopping, restarting, or uninstalling the agent through the normal OS
service manager (`systemctl`/`launchctl`/`Stop-Service`) or the CLI's own
`uninstall` requires a live **override code** — a 6-digit, 30-second
TOTP code (RFC 6238) derived from a secret issued once at enrollment.
Admins read the current code from a node's detail page (**Override
Code** button); the agent verifies it **entirely offline** — no network
call, just the shared secret plus its own clock — so this works even if
the node has no route to the server at all.

- `pktnode-agent uninstall --unlock-code <code>` checks the code inline.
- For a plain service-manager stop, first run `pktnode-agent unlock
  <code>` (grants a 2-minute window), *then* `systemctl stop`/`launchctl
  stop`/`Stop-Service` as normal — the agent's signal/control-request
  handler checks for that grant before honoring the stop and otherwise
  just ignores it, so the service appears to hang rather than exit.

**Honest limit, by design**: this is userland-only — there's no signed
kernel-level component (no macOS System Extension, no WHQL-signed
Windows minifilter, no Linux LSM/eBPF module). A local admin/root user
can always force it with `kill -9`, Task Manager "End process tree", or
equivalent; nothing short of a kernel driver can prevent that on any OS.
What this *does* stop cold is the casual/GUI-level disable path — and
regular (non-admin) local users were already blocked from touching a
root/SYSTEM service before this existed.

## Frontend Build & Deploy

```bash
cd frontend
npm install
npm run build     # outputs frontend/dist, served by the FastAPI app
```

## Configuration Reference

See `config.example.yaml` — covers server bind host/port, install_dir,
JWT secret, CORS origins, node liveness thresholds
(`offline_after_sec`/`stale_after_sec`), logging, and SSL cert paths.
Everything else (notifications, alert thresholds, SSL toggle, suite
integration token, AI assistant key, backup schedule, enrollment tokens)
lives in the SQLite `settings`/`enrollment_tokens` tables and is managed
from the Settings page — not this file.

## Running & Managing the Service

```bash
sudo systemctl status pktnode
sudo systemctl restart pktnode
sudo journalctl -u pktnode -f
```

Or from the UI: Settings → General → Restart Service (admin only).

## Roles & Auth

Three roles: `admin` (full access, including Users and Enrollment),
`analyst` (read access plus queuing remote actions), `viewer` (read-only).
Local username/password auth plus optional SAML 2.0 SSO (Settings →
Security → Auth).

## Alerting

Four built-in rule types, evaluated every 60 seconds:

- `node_offline` — a node hasn't checked in within the offline threshold
- `disk_low` — free disk space below a configured percentage
- `cpu_high` / `mem_high` — average usage over the rule's eval window
  stays above a configured percentage

Notification channels (Slack/Email/PagerDuty/Webhook/TraceCat) are
configured under Settings → Notifications and used by alert rules when
they fire.

## Suite Integration

pktNode exposes `/api/suite/*` for pktHub to call in (inbound), same
pattern as the rest of the suite — configure the shared suite token under
Settings → Security → Suite Integration.

## Backup & Restore

Settings → Data → Backups: scheduled or on-demand snapshots (SQLite DB +
`config.yaml`) with rotation, plus a one-off export/import bundle
(`.tar.gz`). A restore requires a service restart to pick up `config.yaml`
changes. Existing agents keep working against a restored server unchanged,
since their bearer tokens live in the restored DB.

## Troubleshooting

- **Agent shows as offline but the machine is up**: check the agent's own
  logs (macOS: `/var/log/pktnode-agent.log`; Linux: `journalctl -u
  pktnode-agent`; Windows: Event Viewer → Application) and confirm the
  server URL/port is reachable from the endpoint.
- **Install command's binary download 404s**: the server's
  `agent-releases/` directory is empty — run `agent/build.sh` (requires
  Go) and restart the service.
- **New user has no admin account**: `PKTNODE_ADMIN_PASSWORD` must be set
  on first boot when the `users` table is empty; `install.sh` handles this
  automatically.

## Development

Backend:
```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
PKTNODE_ADMIN_PASSWORD=devpass python3 -m app.server
```

Frontend (dev server, proxies `/api` to `localhost:8764`):
```bash
cd frontend && npm install && npm run dev
```

Agent (run directly against a local server without installing a service):
```bash
cd agent
go run . install --server http://localhost:8764 --token <enrollment-token>
```

## Known Gaps / Fast-Follow Work

- Software/process inventory collection shells out to OS tooling
  (`system_profiler` on macOS, `dpkg-query`/`rpm` on Linux, the registry
  uninstall keys on Windows) — best-effort, not exhaustive on every distro
  (notably Alpine/apk isn't handled on Linux).
- No patch/update-management surface yet (OS or third-party).
- No remote screen/shell session — remote actions are fire-and-forget
  script/service/power commands, not interactive.
- `run_script` results truncate very long output; there's no streaming
  output for long-running scripts.
- No tray/status-icon build for Linux (needs GTK3/libappindicator3-dev,
  build natively on Linux) or Windows/arm64 (no readily available cgo
  cross-toolchain for it).
- No two-way messenger/chat between an admin and the logged-in user —
  considered and deliberately deferred; the tray helper has no real GUI
  toolkit today (just tray menu + one-shot native OS dialogs), and a
  persistent chat window would need one added (e.g. Fyne/Wails) first.
- Tamper lockout is userland-only by design (see the "Tamper lockout"
  section above) — no kernel-level enforcement, so a local admin/root can
  always force-kill the process.
