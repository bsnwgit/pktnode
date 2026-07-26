# pktNode

<p align="center">
  <img src="lockup-256h.png" alt="pktNode" height="64">
</p>

RMM (remote monitoring & management) for the pkt suite — tracks and manages
user-level assets (Mac/Windows/Linux endpoints) via a lightweight Go agent
that enrolls with the server, checks in on an interval reporting hardware/
software inventory and live resource usage, executes queued remote actions
(service restarts, reboot/shutdown), opens an instant interactive shell on
a node (Live Terminal), and relays a simple 2-way chat between an admin and
whoever's logged into the machine (via a tray/menu-bar helper).

**Default port:** `8764` (HTTP)

---

## Table of Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Using pktNode](#using-pktnode)
- [Agent](#agent)
- [Frontend Build & Deploy](#frontend-build--deploy)
- [Configuration Reference](#configuration-reference)
- [Running & Managing the Service](#running--managing-the-service)
- [Roles & Auth](#roles--auth)
- [IP Intelligence Lookup](#ip-intelligence-lookup)
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
`POST /api/agent/commands/{id}/result`. Pending admin→agent chat messages
are handed back and flipped to delivered the same way (see
[Messaging](#messaging-tray-chat)).

Separately from that polling loop, the agent also keeps one persistent
outbound WebSocket open to `/api/agent/terminal/ws` for its whole run — a
control channel used only for [Live Terminal](#live-terminal) sessions,
relayed through the in-memory `app/terminal_hub.py` registry to whichever
admin browser opened a matching `/api/nodes/{id}/terminal/ws` connection.

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

## Using pktNode

A quick tour for day-to-day operators (admin/analyst), once the server is up
and at least one node is enrolled — see [Agent](#agent) below for enrollment
itself.

- **Dashboard** (`/`) — total/online/offline/stale/pending node counts and
  active-alert count as clickable tiles (each jumps to the filtered Nodes
  or Alerts view), plus a "recently seen" table of the 10 most recently
  checked-in nodes.
- **Nodes** (`/nodes`) — the full inventory list. Filter by status
  (All/Online/Offline/Stale/Pending/Decommissioned), search by hostname, and
  (admin/analyst) multi-select rows with the checkbox column to **bulk
  reboot or shut down** several nodes at once — each queues a `reboot`/
  `shutdown` command per selected node, applied on that node's next
  check-in, same as the single-node action — or **bulk-assign them to a
  group** via the same selection (see [Groups](#groups)).
- **Node detail** (`/nodes/{id}`) — tabs for Overview (hardware, IP, current
  user, network interfaces, **Groups** membership, and a **Host down
  alerts** override — see [Groups](#groups) and
  [Per-device and group overrides](#per-device-and-group-overrides)),
  Software (installed-package inventory),
  Processes (running-process snapshot, with a per-row **Kill** action),
  Metrics (CPU/mem/disk history chart + table), Commands (remote-action
  history), and Messages (tray chat, see below). Admin/analyst get two
  action buttons at the top:
  - **Live Terminal** — an instant, interactive shell on the node (see
    [Live Terminal](#live-terminal) below) — nothing queued, nothing logged.
  - **Queue Command** — opens a console-style modal to fire a fixed remote
    action (**Restart service**, **Kill process**, **Reboot node**,
    **Shutdown node**) and watch it move from `pending` → `sent` →
    `completed`/`failed` live, without leaving the modal. Every queued
    command is also logged in the Commands tab, and clicking a past row
    reopens the modal seeded with that command's transcript. See
    [Remote actions](#remote-actions) for exactly what each type does and
    its current caveats.
  - Admins additionally get **Override Code** (the live TOTP code for
    locally stopping/uninstalling the agent — see
    [Tamper lockout](#tamper-lockout-override-code)) and
    **Decommission & Revoke** / **Delete Permanently**.
- **Messaging a node** — the Messages tab is a simple chat thread with
  whoever is logged into that node, delivered through the tray helper (see
  [Messaging](#messaging-tray-chat) below). **Nodes with no tray helper
  running can't be messaged at all** — the tab shows a warning banner and
  hides the send box, and the server rejects the send outright, not just
  the UI.
- **Enrollment** (`/enrollment`, admin only) — its own top-level nav item,
  not under Settings — issue and manage enrollment tokens (see
  [Enrolling a node](#enrolling-a-node)).

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

1. In the UI: **Enrollment** (its own top-level nav item, admin only) →
   **New Token**. Optionally set a label, an expiry, and a max-use count (1
   for a single-machine install, unlimited for a shared rollout token).
   Tokens are split into **Active**/**Revoked** tabs; the raw token string
   is only ever shown once, but **Get Install Command** on a token's row
   generates a fresh one for the same token (same label/limits, use count
   reset) if you navigated away before copying it.
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

From a node's detail page (**Queue Command**) or in bulk from the Nodes
list (multi-select → Reboot/Shut Down), admins/analysts can queue:
`restart_service`, `kill_process`, `reboot`, `shutdown`. Commands are
picked up on the node's next check-in (so latency is bounded by the
check-in interval, not instant — up to a minute is normal) and results
are visible in the node's Commands tab, or live in the Queue Command modal
while a command you just fired is still in flight.

The server API also still accepts a `run_script` command type (shell on
macOS/Linux, PowerShell on Windows) and the agent still executes it — but
it is **not currently exposed as an option in the Queue Command modal**.
For one-off/ad-hoc commands today, use [Live Terminal](#live-terminal)
instead, which is interactive and instant rather than queued.

### Live Terminal

A real interactive shell on the node, opened from the **Live Terminal**
button on a node's detail page — not another queue-and-poll round trip.
Separately from its periodic HTTP check-in, the agent keeps one
persistent outbound WebSocket open to the server the whole time it runs
(a control channel — see `agent/internal/terminal/terminal.go` and
`app/terminal_hub.py` for the wire protocol); an admin's browser opens a
second WebSocket to the server, which relays JSON-framed input/output
frames between the two. The node still never accepts an inbound
connection of any kind — the agent always dials out, so no firewall
changes are needed on the managed machine's end.

A second admin opening a terminal on the same node preempts (not queues
behind) any existing session — the older tab is told "Another admin
started a new terminal session on this node" and closed. If the node has
no live control-channel connection (agent offline, or an older agent
build that predates this feature), the button reports that plainly
instead of hanging.

### Messaging (tray chat)

A simple 2-way chat between an admin and whoever is logged into the node,
from the node detail page's **Messages** tab. Admin → agent messages are
handed to the agent on its next check-in and shown as a native OS dialog
by the tray helper (see below); a reply typed into that dialog is relayed
back the same way check-in results are, and shows up in the Messages tab
on the admin's next poll (it refreshes every 10s while that tab is open).
There is no live push in either direction — delivery in both directions
is bounded by the check-in interval.

**A node with no tray helper running can't be messaged, period** — the
agent reports `has_tray` on every check-in (always `false` on headless
Linux, and on Linux in general until a tray build ships — see
[Status icon](#status-icon-tray-helper)). The Messages tab shows a
warning banner and hides the send box for such a node, and
`POST /api/nodes/{id}/messages` rejects the send server-side too, so this
isn't just a frontend nicety.

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

The menu itself is deliberately minimal: a disabled status line
(online/checking-in-failing + relative last-check-in time), a disabled
line showing the configured server URL, and **Stop Agent…**. There is no
"Open pktNode" item — regular users on a node don't get a shortcut to the
admin web UI from here. When an admin sends this node a message (see
[Messaging](#messaging-tray-chat)), the tray shows it as a native OS
dialog (`osascript`/PowerShell `InputBox`/`zenity`) with a free-text reply
field, one message at a time.

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
integration token, AI assistant key, backup schedule, enrollment tokens,
agent check-in interval) lives in the SQLite `settings`/`enrollment_tokens`
tables and is managed from the Settings page — not this file.

**Agent check-in interval** (Settings → General, default 60s, 15–3600s
range) controls how often every node calls home — it's also the floor on
how fast a queued remote action or a chat message can reach a node.
**Caveat as currently implemented**: this only takes effect for agents
enrolling *after* the change. An agent already running keeps the interval
it received at its own enroll time — the check-in response does carry the
current setting back on every check-in, but the agent loop doesn't yet
apply it to a process that's already running, and restarting the agent
service doesn't re-fetch it either (it reloads the same value from its
local config file). Re-enrolling a node is currently the only way to pick
up a changed interval on an existing install.

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

## IP Intelligence Lookup

`GET /api/ip-info/{ip}` runs a public IP through four providers concurrently:

- **ipinfo.io** — geolocation/ASN/org info, plus company, privacy (VPN/proxy/Tor/relay/hosting), and abuse contact on paid plans
- **ipapi.is** — geolocation, ASN/org, company, abuse contact, VPN/proxy/Tor/datacenter/abuser detection, all in one call, no plan gating
- **AbuseIPDB** — abuse confidence score and report history
- **MXToolbox** — reverse DNS (PTR), ASN, and a blacklist/RBL check

Private/loopback/link-local/reserved/multicast addresses are rejected — external providers have nothing useful to say about them.

Keys are **per-user**, not app-wide: each logged-in user stores their own under Settings → User Keys (`app/api/user_api_keys.py`), and lookups run under that user's own key/quota — no shared/admin key, no cross-user visibility. A fifth provider slot, IPQualityScore, can be saved and tested there but isn't consumed by the lookup yet.

MXToolbox's other commands — email/DNS record checks (SPF, DMARC, DKIM, MX, DNS, TXT, SOA, BIMI, MTA-STS, TLSRPT, A, AAAA) and active probes (ping, traceroute, TCP/HTTP/HTTPS/SMTP connect, run from MXToolbox's own infrastructure against the target) — are reachable via `POST /api/mxtoolbox/lookup` (`{command, argument, port?}`, `app/api/mxtoolbox.py`) but aren't surfaced in the UI yet.

**Backend-only for now**: unlike pktsnmp/pktflow/pktlog/pktwifi, no page in pktNode actually renders an IP address as a clickable link into this lookup yet (a node's own IP on its detail page and the Nodes list are still plain text) — the API and the Settings → User Keys management UI are both fully wired, there's just no click-through surface pointed at them yet.

## Alerting

Four built-in rule types, evaluated every 60 seconds:

- `node_offline` — a node hasn't checked in within the offline threshold
- `disk_low` — free disk space below a configured percentage
- `cpu_high` / `mem_high` — average usage over the rule's eval window
  stays above a configured percentage

Rules themselves (thresholds, severity, notification channels, cooldown)
are managed on the **Alerts** page → Rules tab. Nothing stops you from
creating more than one rule of the same type — e.g. a `warning`-severity
and a `critical`-severity `disk_low` rule at different thresholds.

Notification channels (Slack/Email/PagerDuty/Webhook/TraceCat) are
configured under Settings → Notifications and used by alert rules when
they fire.

### Per-device and group overrides

Every alert's on/off state (and, for the three threshold-based types, its
threshold) resolves through a 3-level override chain, most specific wins:

1. **Per-device** (`node_offline` only) — a device's own page (Overview
   tab) has a **Host down alerts** dropdown: *Inherit from Settings* /
   *Always alert* / *Never alert*. Use this for one machine that's expected
   to go offline routinely (e.g. a workstation that's shut down every
   night) without touching the rule or creating a whole group for it.
2. **Per-group** (all four rule types, plus threshold overrides) — see
   Groups below.
3. **The rule's own default** — `alert_host_down_enabled` (Settings →
   General) for `node_offline`; each rule's own `threshold_pct` (Alerts →
   Rules) for the other three.

Turning an alert off at any level also auto-resolves any event already
open for it — it doesn't just suppress future firing.

### Groups

Groups are created and deleted from **Settings → Groups** (admin only) —
that is the *only* place one comes into existence. A device's own page (or
the Nodes list's bulk action, below) just picks from that existing list; it
can't invent a new group name, and this is enforced server-side, not just
hidden in the UI.

- **Assign one device**: on its detail page (Overview tab), the **Groups**
  section shows a chip per group it's already in (with a remove button)
  and a dropdown to add it to any other existing group. A device can be in
  more than one group at once.
- **Assign in bulk**: on the **Nodes** page, multi-select devices with the
  checkbox column, then use the **Assign to group…** dropdown that appears
  in the bulk action bar alongside Reboot/Shut Down — adds that group to
  every selected device without disturbing their other memberships.
- **Group alert overrides** (Settings → Groups): each group can override
  any specific *configured alert rule* — by rule, not just by type, since
  (as above) you can have more than one rule of the same type and a
  type-wide override couldn't tell them apart. Each row lets you force
  that rule **Inherit / Always alert / Never alert** for the group's
  members, and, for `disk_low`/`cpu_high`/`mem_high`, override its
  threshold % (leave blank to inherit the rule's own value).
- **Conflicting groups**: if a device is in two groups with different
  settings for the *same field* of the *same rule*, whichever group's
  setting was saved most recently wins. Non-overlapping fields both
  apply — e.g. Group A's `enabled=off` and Group B's `threshold_pct=5` on
  the same rule both take effect together.
- **Deleting a group** strips it from every device currently in it and
  drops whatever alert overrides were set for it.

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
- Queued remote actions (Queue Command / bulk Reboot/Shut Down) are still
  fire-and-forget, not interactive — use Live Terminal for anything that
  needs a live session. `run_script` still works at the API level but
  isn't exposed as a Queue Command option in the current UI.
- No tray/status-icon build for Linux (needs GTK3/libappindicator3-dev,
  build natively on Linux) or Windows/arm64 (no readily available cgo
  cross-toolchain for it) — which also means no tray chat and no
  messaging support on those targets (see [Messaging](#messaging-tray-chat)).
- Messaging is a single OS dialog at a time (native `osascript`/`InputBox`/
  `zenity`, not a persistent chat window) — fine for short exchanges, not
  a real chat UI.
- Changing the agent check-in interval in Settings doesn't propagate to
  already-running agents — see the caveat in
  [Configuration Reference](#configuration-reference); only newly-enrolled
  agents pick up a changed value.
- Tamper lockout is userland-only by design (see the "Tamper lockout"
  section above) — no kernel-level enforcement, so a local admin/root can
  always force-kill the process.
