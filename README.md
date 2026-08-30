# pktNode

<p align="center">
  <img src="lockup-256h.png" alt="pktNode" height="64">
</p>

RMM (remote monitoring & management) for the [pkt suite](#the-pkt-suite) — tracks and manages
user-level assets (Mac/Windows/Linux endpoints) via a lightweight Go agent
that enrolls with the server, checks in on an interval reporting hardware/
software inventory and live resource usage, executes queued remote actions
(service restarts, reboot/shutdown, agent self-update), and opens an
instant interactive shell on a node (Live Terminal), browses/transfers
files on it (File Transfer), or forces an immediate check-in — all three
over the same always-open control channel.

**Default port:** `8764` (HTTP)

---

## Table of Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Using pktNode](#using-pktnode)
- [Agent](#agent)
- [Log Forwarding](#log-forwarding)
  - [Security Signals](#security-signals)
  - [Disk Tools](#disk-tools-agent-080)
  - [Platform Support: Unraid & Home Assistant OS](#platform-support-unraid--home-assistant-os)
  - [Speed Test](#speed-test)
  - [Updating Agents](#updating-agents)
- [Frontend Build & Deploy](#frontend-build--deploy)
- [Configuration Reference](#configuration-reference)
- [Running & Managing the Service](#running--managing-the-service)
- [Roles & Auth](#roles--auth)
- [IP Intelligence Lookup](#ip-intelligence-lookup)
- [Alerting](#alerting)
- [Logs](#logs)
- [Suite Integration](#suite-integration)
- [Backup & Restore](#backup--restore)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Known Gaps / Fast-Follow Work](#known-gaps--fast-follow-work)
- [The pkt suite](#the-pkt-suite)

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

Separately from that polling loop, the agent also keeps one persistent
outbound WebSocket open to `/api/agent/terminal/ws` for its whole run — a
control channel carrying two independent kinds of session, relayed
through the in-memory `app/terminal_hub.py` registry: [Live
Terminal](#live-terminal) sessions to a matching
`/api/nodes/{id}/terminal/ws` browser connection, and [File
Transfer](#file-transfer) sessions to a matching
`/api/nodes/{id}/files/ws` one. A node can have one of each open at once
(a terminal and a file browser don't preempt each other, only a second
session of their own kind does).

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
  check-in, same as the single-node action — **bulk-assign them to a
  group** via the same selection (see [Groups](#groups)), **push an
  agent update** to the selection, or **Check In Now** them all (agent
  0.3.0+) — pushes an immediate check-in over each selected node's live
  control channel instead of waiting for its next scheduled one, same
  mechanism as the single-node action (see
  [Check In Now](#check-in-now-agent-030)). The page header also shows
  the current **Latest agent** version (from `agent-releases/VERSION`)
  with an **Update N outdated agents** button that pushes to every
  active node not already on it, no selection needed — see
  [Updating agents](#updating-agents).
- **Node detail** (`/nodes/{id}`) — four main tabs, most with their own
  subtabs:
  - **Overview** — hardware summary, IP, current user, network interfaces,
    group membership, and an **Actions** card (admin/analyst) with
    **Check In Now** plus, admin-only, **Override Code**, **Decommission &
    Revoke**, and **Delete Permanently**. Also shows **Agent version**,
    with an inline **Update to vX.Y.Z** link whenever this node is behind
    the latest available build.
  - **System** → Software (installed-package inventory), Processing
    (running-process snapshot, with a per-row **Kill** action), Security
    (listening TCP/UDP ports and a best-effort host firewall
    enabled/disabled state — see [Security signals](#security-signals)),
    Settings (this node's **Groups** membership and its **Host down
    alerts** override — see [Groups](#groups) and
    [Per-device and group overrides](#per-device-and-group-overrides)).
  - **Metrics** → System (CPU/mem/disk history chart + table) and Network
    (inbound/outbound throughput history, agent 0.8.0+).
  - **Utils** → Commands (remote-action history, with its own **Queue
    Command** button to fire a fixed remote action — **Restart service**,
    **Kill process**, **Reboot node**, **Shutdown node**, **Update
    agent**, plus, on Unraid/Home Assistant OS nodes, container/VM
    start/stop/restart — and watch it move from `pending` → `sent` →
    `completed`/`failed` live without leaving the modal; see
    [Remote actions](#remote-actions) for what each type does), Storage
    (per-volume disk usage), Disk Tools (largest-files scan, temp
    cleanup, disk health check — agent 0.8.0+, hidden on Home Assistant OS
    nodes), Speed Test (see [Speed Test](#speed-test) below).
  - Unraid nodes additionally get an **Unraid** main tab: array/parity
    status + per-disk roster, Docker container inventory, and VM
    inventory, each with start/stop/restart control — see
    [Platform support](#platform-support-unraid--home-assistant-os).
  - Admins/analysts also get a **Live Terminal** button in the page header
    for an instant, interactive shell on the node (see
    [Live Terminal](#live-terminal) below) — nothing queued, nothing
    logged — plus a **File Transfer** button to browse the node's
    filesystem and upload/download files (see
    [File Transfer](#file-transfer) below).
- **Enrollment** (`/enrollment`, admin only) — its own top-level nav item,
  not under Settings — issue and manage enrollment tokens (see
  [Enrolling a node](#enrolling-a-node)).
- **Logs** (`/logs`) — the server's own application log, in-app rather than
  SSH+`journalctl` (see [Logs](#logs) below).

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
   for a single-machine install, unlimited for a shared rollout token). The
   raw token string is only ever shown once, but **Get Install Command** on
   a token's row generates a fresh one for the same token (same
   label/limits) if you navigated away before copying it — a finite-use
   token is **deleted outright, not just revoked, the instant its last use
   is consumed** (`app/enrollment_cleanup.py` also runs a daily sweep that
   deletes anything expired or left completely unused past its expiry), so
   there's never a spent row sitting in the list to regenerate a command
   for.
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

Every check-in: CPU/memory/disk %, network throughput (in/out Mbps,
appended to a history table — see the Metrics → Network subtab), uptime,
current logged-in user, primary IP. Every 15th check-in (configurable via
the check-in cadence, not independently): full software inventory,
running-process snapshot, network interfaces, listening ports, host
firewall status, and per-volume disk usage — all replaced wholesale each
time, not appended to history (see
[Security signals](#security-signals)).

### Disk tools (agent 0.8.0+)

A node's Utils → Disk Tools subtab queues three on-demand actions the same
way as any other remote action (pending → sent → completed/failed, results
retained on the tab, nothing scheduled automatically):

- `disk_largest_files` — scans the node's primary volume for its largest
  files. Filesystem-boundary aware (`deviceOf()` in
  `agent/internal/commands/commands_unix.go`, comparing each entry's device
  ID against the scan root's) so it doesn't wander into virtual mounts like
  `/proc`, whose files can report bogus sizes (`/proc/kcore` reporting
  itself as 128TB was the bug that motivated this check).
- `disk_cleanup_temp` — dry-run preview first, then a real, age-bounded
  deletion pass over temp-directory files.
- `disk_health_check` — SMART status via `smartctl` where available.

Not available on Home Assistant OS nodes — see
[Platform support](#platform-support-unraid--home-assistant-os) below.

### Security signals

As of agent `0.2.0`, every full-inventory check-in also reports:

- **Listening ports** — every locally listening TCP/UDP port, cross-platform
  via `gopsutil` (no per-OS shell-outs), with the owning process name/PID
  where resolvable. This is what feeds pktSecurity's exposed-service risk
  scoring when pktNode is added as an asset source there — a node with, say,
  RDP or Redis listening moves its exposure score the moment this data
  exists, with no configuration needed on pktSecurity's side.
- **Host firewall status** — `enabled` / `disabled` / `unknown`, detected
  per-OS: `socketfilterfw --getglobalstate` on macOS, `ufw status` falling
  back to `firewall-cmd --state` on Linux, `Get-NetFirewallProfile` on
  Windows. `unknown` covers hosts where none of those are present (e.g. bare
  iptables/nftables with no front-end) — this is a best-effort signal, not a
  guarantee. **Informational only for now**: it's visible on the node's
  Security tab and passed through to pktSecurity, but nothing currently
  scores risk or compliance on it.

Both are visible on a node's **Security** tab. **Agents already enrolled
before 0.2.0 won't report either field until updated** — see
[Updating agents](#updating-agents) below.

### Remote actions

From a node's detail page (**Queue Command**) or in bulk from the Nodes
list (multi-select → Reboot/Shut Down), admins/analysts can queue:
`restart_service`, `kill_process`, `reboot`, `shutdown`, `update_agent`, and
— on Unraid and Home Assistant OS nodes — `docker_start`/`docker_stop`/
`docker_restart` (container or add-on, addressed by name/slug) plus, on
Unraid only, `vm_start`/`vm_stop`/`vm_restart`. Commands are picked up on
the node's next check-in (so latency is bounded by the check-in interval,
not instant — up to a minute is normal, or immediately if followed by
[Check In Now](#check-in-now-agent-030)) and results are visible in the
node's Commands tab, or live in the Queue Command modal while a command you
just fired is still in flight.

The server API also still accepts a `run_script` command type (shell on
macOS/Linux, PowerShell on Windows) and the agent still executes it — but
it is **not currently exposed as an option in the Queue Command modal**.
For one-off/ad-hoc commands today, use [Live Terminal](#live-terminal)
instead, which is interactive and instant rather than queued.

### Platform support: Unraid & Home Assistant OS

Beyond macOS/Linux/Windows, the same `pktnode-agent` binary — same version,
same `AgentVersion` constant — also runs on two more platforms, detected at
runtime rather than requiring a separate build:

**Unraid** (`inventory.IsUnraid()`, checking for `/etc/unraid-version`)
installs like a normal Linux host with two platform-specific pieces:

- `/boot` is FAT32-mounted without exec permission, so the canonical binary
  lives there but `refreshRunCopy()` maintains a refreshed, executable copy
  at `/usr/local/pktnode-agent/` on every launch.
- Unraid has no systemd, so persistence across reboots comes from a guarded
  block added to `/boot/config/go` (Unraid's own boot-hook file) that
  starts `pktnode-agent supervise` on every boot.

Nodes reporting `os_type: unraid` get an extra **Unraid** tab: array/parity
status and per-disk roster (parsed from Unraid's `emhttp` state files at
`/var/local/emhttp/{var,disks}.ini`), Docker container inventory with
start/stop/restart, and libvirt VM inventory with start/stop/restart — all
queued through the normal command mechanism. Software inventory reads
Unraid's native Slackware package database (`/var/log/packages`, filename-
encoded `name-version-arch-build` entries) instead of the deb/rpm formats
used elsewhere. Uninstall goes through the same tamper-lockout unlock flow
as any other platform.

**Home Assistant OS** (`inventory.IsHAOS()`, checking for a `SUPERVISOR_TOKEN`
env var) can't be installed onto natively — instead the agent runs as a
Home Assistant **Supervisor Add-on** (Docker-based, built from
`homeassistant-addon/pktnode-agent/`), installed via:

```bash
curl -fsSL http://<server>:8764/install-haos-addon.sh | bash -s -- --server http://<server>:8764
```

run from the HA host's own shell. This stages the add-on into
`/addons/local/pktnode-agent/` and downloads the matching binary from
`/agent-releases/`; from there it's a normal local add-on install
(**Settings → Add-ons → Add-on Store**) with **Server URL**/**Enrollment
Token** set in its Configuration tab. At runtime, `SUPERVISOR_TOKEN` being
present routes the agent into `agent/internal/haosloop` instead of the
usual `svcrun`, which collects through the Supervisor's REST API
(`http://supervisor/*`) rather than native OS calls, since a Supervisor
add-on has no direct host access.

Known, permanent platform limitations (Supervisor API has no equivalent —
not agent bugs): **Processing and Security tabs report no data** (no
process-list or ports/firewall API); **Disk Tools and Speed Test aren't
available** (no filesystem access for the former; the latter isn't wired
up for HAOS yet); **CPU/memory are an approximation**, summed from Home
Assistant Core + Supervisor + every add-on's own reported container stats
rather than a true whole-host reading. Reboot/shutdown route through
`/host/reboot`/`/host/shutdown`; Docker commands are interpreted as add-on
slugs and route through `/addons/<slug>/{start,stop,restart}`.

The HA Add-on Store's local-listing cache can go stale in either direction
after updating add-on files on the box — it may not pick up new files, or
may keep listing files that are already gone (`Dockerfile is missing` on
install). **Settings → System → Restart → Restart Home Assistant** (not
just the add-on) reliably clears this.

### Updating agents

`update_agent` (agent 0.2.0+) is what powers everything described above as
a "push": the Nodes list's per-node/bulk/all-outdated actions and a node's
own Overview **Update to vX.Y.Z** link all just queue this command type,
same as any other remote action.

On execution, the agent:

1. Downloads the release binary matching its own OS/arch from this
   server's `/agent-releases/` (built by `agent/build.sh` — see
   [Building](#building)).
2. Atomically swaps it in over its own currently-running binary (rename,
   not truncate — safe even though the old binary is still executing;
   same trick the installer itself uses).
3. Restarts itself: on macOS/Linux this reuses the existing tamper-lockout
   unlock-grant + signal path (the same mechanism an admin-authorized stop
   goes through), then relies on `Restart=always`/`KeepAlive=true` to
   relaunch it. Windows SCM won't auto-restart a cleanly-stopped service,
   so there it schedules a short-delayed detached `sc start` helper first,
   then requests its own stop the same way.
4. If the [tray helper](#status-icon-tray-helper) is already installed on
   this machine, best-effort updates that too (agent 0.3.0+) —
   downloads and swaps its binary the same way, then relaunches it
   immediately on macOS (`launchctl kickstart -k`, since its LaunchAgent
   has no `KeepAlive` to relaunch it on its own). Linux/Windows have no
   live restart mechanism for it (XDG autostart / per-login "Run" key),
   so there the new tray binary just takes effect at the user's next
   login. A tray isn't installed fresh by this — only refreshed if one's
   already there. **Agents on 0.2.0** (which already understand
   `update_agent` itself, just not this part) **update their own binary
   fine but skip the tray** — one push gets them to 0.3.0+, after which
   the tray comes along too.

The command reports `completed` (with the binary swap already done) before
the restart actually lands, so the queued command's result doesn't race the
process going away.

**Only agents already on 0.2.0+ understand `update_agent` at all** — an
agent older than that just reports it as an unknown command type and stays
on its current build. Get it onto 0.2.0+ once via a normal reinstall
(Enrollment page → node row → **Get Install Command**); every push after
that works normally.

### Speed Test

From a node's detail page, a **Speedtest** tab runs a real download/upload/
latency test via [M-Lab's NDT7 protocol](https://github.com/m-lab/ndt7-client-go)
— no API key or bundled external binary (unlike Ookla's CLI), just a Go
client compiled into the agent. A nearby M-Lab measurement server is
auto-discovered via M-Lab's public Locate API each run.

- **On-demand**: **Run Speedtest Now** on the tab queues a `run_speedtest`
  command through the same command queue as Remote Actions above —
  pending → sent → completed/failed, up to a check-in interval of
  latency, same as any other queued action.
- **Scheduled**: `Settings → General → Speedtest schedule` sets a
  server-wide interval in hours (`0` = off, the default). Unlike the
  check-in interval's caveat below, this setting *does* take effect on an
  already-running agent — it's re-read fresh from every check-in response
  rather than cached at process start, so no re-enroll is needed when you
  change it.
- Only one speed test runs at a time per node — if a scheduled run and a
  manual "Run Speedtest Now" collide, the second one is skipped/rejected
  rather than queued behind the first.
- Every run (manual or scheduled, completed or failed) is logged to a
  dedicated history table on the Speedtest tab: download/upload Mbps,
  latency/jitter in ms (from the M-Lab server's own TCP_INFO
  instrumentation — reported regardless of the node's own OS), which
  server was used, and what triggered it.
- **Agents already enrolled before the speed test feature shipped won't
  have it until updated** — see [Updating agents](#updating-agents) above
  (agents already on 0.2.0+, which shipped speed test, can just be pushed;
  anything older needs one reinstall first).

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

### File Transfer (agent 0.9.0+)

Browse, upload, download, rename, delete, and create folders on a node's
filesystem from the **File Transfer** button next to Live Terminal — a
second, independent session type multiplexed over the same control
channel (`agent/internal/terminal/file.go` on the agent,
`app/terminal_hub.py`'s `FileHub` on the server), so it can be open at the
same time as a Live Terminal session on the same node without either
preempting the other. Same reachability requirement and same preemption
rule as Live Terminal, just scoped to its own session slot: no live
connection reports that plainly, and a second admin opening File Transfer
on the same node preempts the first. Transfers are chunked JSON/base64
frames over that WebSocket, capped at 500 MB per file — built for configs,
logs, and installers, not bulk/bare-metal-scale transfers.

**Defaults into the node's home directory, not filesystem root (agent
0.9.1+)** — the initial listing lands wherever `os.UserHomeDir()` resolves
on that node, with a **Root** breadcrumb one click away for browsing the
whole filesystem. This matters specifically because of:

**macOS's sealed System volume — expected read-only behavior, not a
bug.** Since Big Sur, macOS boots from a cryptographically signed, sealed
System volume: `/`, `/System`, `/bin`, `/sbin`, and `/usr` (excluding
`/usr/local`) are read-only for *everyone*, including root — this is
enforced by the volume's signature check, not a Unix permission bit, so
**no privilege level can write there over a normal session**. `sudo scp`
over Live Terminal fails with the identical "read-only file system" error
File Transfer would show, because both are just an ordinary userland
process on the running OS. The only way to write to that volume at all is
`csrutil authenticated-root disable` from macOS Recovery Mode followed by
a reboot — local/physical (or remote-KVM-style) console access, not
reachable from any agent-mediated session. Everything else a user would
actually want to reach — `/Users`, `/Library`, `/Applications`,
`/private/tmp`, `/private/var`, and every home directory — is firmlinked
to the writable Data volume and works normally through File Transfer, same
as it would through `scp`. Linux and Windows nodes have no equivalent
volume-level restriction; ordinary filesystem permissions are all that
apply there.

Agents older than 0.9.0 don't understand the file_* protocol at all — the
control channel stays open (Live Terminal still works) but a File
Transfer session just sits at "Connecting…" with no response, same as any
other message type an older agent's dispatch loop has no case for. Push
an [agent update](#updating-agents) to fix that.

### Check In Now (agent 0.3.0+)

Piggybacks on that same always-open control channel rather than opening
anything new: `POST /api/nodes/{id}/checkin-now` looks up the node's live
`AgentLink` in `app/terminal_hub.py`'s registry and sends it a
`{"type": "checkin_now"}` frame. The agent's control-channel reader
(`agent/internal/terminal/terminal.go`) recognizes that type specially —
instead of dispatching it to the PTY session manager, it signals
`agentloop.Run`'s main check-in loop (over a small buffered channel) to
skip the rest of the current interval and check in immediately. This is
what makes a command you just queued (including `update_agent`) or a
fresh inventory snapshot show up right away instead of waiting out
whatever the check-in interval happens to be. Same reachability
requirement as Live Terminal — no live control-channel connection means
the button reports that plainly rather than silently doing nothing.
**Agents older than 0.3.0 keep the control channel itself open (Live
Terminal still works on them) but their message loop has no case for
`checkin_now` yet, so it's silently ignored** — harmless, the button
just has no visible effect until that node is updated once.

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
line showing the configured server URL, **About pktNode Agent** (a native
dialog with the agent's version, server URL, check-in interval, and
current status — read from the same `status.json`), and **Stop Agent…**.
There is no "Open pktNode" item — regular users on a node don't get a
shortcut to the admin web UI from here.

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
integration token, backup schedule, enrollment tokens,
agent check-in interval) lives in the SQLite `settings`/`enrollment_tokens`
tables and is managed from the Settings page — not this file.
turned into spurious failures; cloud providers rarely approach it.

**Settings layout.** The page is split into two sections, chosen from a
section bar above the tab bar: **Common** (General · Security · Data ·
Notifications · User Keys · System — identical across every pkt* app) and
**pktNode** (Groups). Only the selected section's tabs are shown; deep
links like `/settings?tab=groups` select the section automatically.
Enrollment, pktNode's other app-specific area, is a top-level nav item
rather than a Settings tab.

**Agent check-in interval** (Settings → General, default 60s, 15–3600s
range) controls how often every node calls home — it's also the floor on
how fast a queued remote action can reach a node.
**Caveat as currently implemented**: this only takes effect for agents
enrolling *after* the change. An agent already running keeps the interval
it received at its own enroll time — the check-in response does carry the
current setting back on every check-in, but the agent loop doesn't yet
apply it to a process that's already running, and restarting the agent
service doesn't re-fetch it either (it reloads the same value from its
local config file). Re-enrolling a node is currently the only way to pick
up a changed interval on an existing install.

**Speedtest schedule** (Settings → General, default `0` = off, hours)
controls how often each node runs an unattended [speed test](#speed-test).
Unlike the check-in interval above, this one is re-read from every
check-in response rather than cached at agent startup, so changing it
applies to already-running agents on their very next check-in.

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

Keys are **per-user**, not app-wide: each logged-in user stores their own under Settings → User Keys (`app/api/user_api_keys.py`), and lookups run under that user's own key/quota — no shared/admin key, no cross-user visibility. Keys are Fernet-encrypted at rest (`app/crypto.py`, using a dedicated `credential_key` — separate from `secret_key`, which only signs JWTs) — decrypted only in memory when a lookup runs or the owning user views their own key. A fifth provider slot, IPQualityScore, can be saved and tested there but isn't consumed by the lookup yet.

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

## Logs

The **Logs** page (`/logs`, any role) is an in-app viewer for pktNode's own
application log — `GET /api/logs`, backed by a `app_logs` SQLite table fed
by a logging handler (`app/logging_handler.py`) attached to the root
logger, not a raw `journalctl`/log-file tail.

- **Filters**: minimum level (ALL/DEBUG/INFO/WARNING/ERROR/CRITICAL),
  logger-name prefix, free-text search over the message, and a time
  window — quick presets (1h/6h/24h/7d/30d/all time) or a custom
  from/to range, with both sides clamped so a future timestamp can't be
  picked and an invalid (end-before-start) range is rejected inline
  rather than silently applied.
- **Stats** (`GET /api/logs/stats`): total record count, a count per
  level, the distinct set of logger names seen, and the most recent
  timestamp — used to populate the page's summary tiles and the logger
  filter's options.
- **Capture level** (admin only, `POST /api/logs/level`): sets the
  minimum level the root logger actually persists to `app_logs` at
  runtime (default `WARNING`) — lowering it to `INFO`/`DEBUG` surfaces
  more detail for active troubleshooting without a restart or a config
  file edit; the dropdown reflects the level currently in effect.
- **Clear** (admin only, `DELETE /api/logs`): wipes every stored log
  record.
- Results are paginated with a page-size selector (25/50/75/100), shared
  with the same control on the Alerts and Node Detail (Commands/Metrics)
  tables.

## Suite Integration

pktNode exposes `/api/suite/*` for pktHub to call in (inbound), same
pattern as the rest of the suite — configure the shared suite token under
Settings → Security → Suite Integration.

### Nav manifest (pktHub's APPS sidebar)

`GET /api/nav/manifest` (`app/api/nav.py`) publishes pktNode's own left-nav so
pktHub can mirror it under **APPS** in its sidebar. Entries are
`{path, label, icon, admin_only, divider_before}`. pktHub's health poller
reads the endpoint on every cycle and caches the result, so a page added here
shows up in the hub within one poll interval with no change on the hub side.

Selecting one of those rows opens pktNode's **real page** inside pktHub —
proxied, and chromeless so it renders without this app's own sidebar or
header. It is not a re-implementation and cannot drift from what the page
actually does.

`NAV_MANIFEST` in `app/api/nav.py` and `NAV` in
`frontend/src/components/Layout.tsx` are two declarations of one menu, and each
carries a comment pointing at the other — a page added to one belongs in both.
The endpoint is gated by `require_suite_token` for the same reason the widget
endpoints are: it discloses this app's page structure.

`admin_only` controls only what the hub *draws*. The real authorisation is
this app's own role check against the `X-Suite-Role` pktHub asserts.

### Chromeless layout needs a definite height

`Layout.tsx`'s chromeless branch uses `h-screen overflow-auto`, not
`min-h-screen`. A page that fills its container sizes itself with `h-full`,
which resolves against the parent's height — and collapses to zero against an
auto-height parent, rendering blank. Maps and canvases hit this first.


## Backup & Restore

Settings → Data → Backups: scheduled or on-demand snapshots (SQLite DB +
`config.yaml`) with rotation, plus a one-off export/import bundle
(`.tar.gz`). Each listed snapshot has a **Restore…** link that restores
directly from that on-server snapshot — no download/upload round trip
required — and lets you pick just `pktnode.db` or just `config.yaml`
instead of always restoring both together; the same per-file selection is
available on the bundle-upload restore. A restore requires a service
restart to pick up `config.yaml` changes. Existing agents keep working
against a restored server unchanged, since their bearer tokens live in the
restored DB.

### Backup integrity

Database snapshots are taken through SQLite's own online-backup API and then
verified with `PRAGMA integrity_check`; a snapshot that does not pass is logged
loudly and not counted as usable.

This matters more than it sounds. The database runs in WAL mode, so at any
instant the committed state is split between the `.db` file and its `-wal`
sidecar. The previous implementation copied the `.db` alone with `shutil.copy2`,
which captures neither a consistent snapshot nor the most recent commits — the
worst possible failure mode for the one artifact you reach for in an emergency,
because it looks like a backup either way.


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
- **File Transfer says "read-only file system" uploading to a macOS
  node**: expected behavior, not a bug — see
  [File Transfer](#file-transfer) above. It means the target is on the
  sealed System volume (root, `/System`, `/bin`, `/sbin`, `/usr`); navigate
  into the home directory (the default landing spot on agent 0.9.1+) or
  another writable location like `/Users/...`, `/Library`, `/Applications`,
  or `/private/tmp` instead. No privilege level, including `sudo` over
  Live Terminal, can write to that volume in a normal session.
- **File Transfer session sits at "Connecting…" forever**: the node's
  agent predates 0.9.0 and doesn't understand the file transfer protocol —
  push an [agent update](#updating-agents); Live Terminal on the same node
  working fine is consistent with this (its control channel is open, just
  an older build).

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
- No patch/update-management surface yet (OS or third-party) — deliberately
  out of scope for [Security signals](#security-signals) v1, since checking
  it is slow (macOS `softwareupdate -l` can take 10-30s+) and per-OS
  quirky (apt/yum cache state, Windows WMI); would need its own
  slower-cadence poll rather than riding the regular check-in.
- No auth/login event telemetry (failed/successful logins) — a different
  category of data than the inventory-style check-in handles today; would
  need a log-tailing cursor to avoid re-delivering the same events and,
  on Windows, elevated rights to read the Security event log.
- Queued remote actions (Queue Command / bulk Reboot/Shut Down) are still
  fire-and-forget, not interactive — use Live Terminal for anything that
  needs a live session. `run_script` still works at the API level but
  isn't exposed as a Queue Command option in the current UI.
- Agent self-update ([Updating Agents](#updating-agents)) only works
  between agents that already understand the `update_agent` command —
  anything enrolled before 0.2.0 needs one manual reinstall first. There's
  also no version pinning/rollback: a push always installs whatever's
  currently sitting in `agent-releases/` on the server.
- No tray/status-icon build for Linux (needs GTK3/libappindicator3-dev,
  build natively on Linux) or Windows/arm64 (no readily available cgo
  cross-toolchain for it) — those targets get no menu-bar/tray icon at all.
- Changing the agent check-in interval in Settings doesn't propagate to
  already-running agents — see the caveat in
  [Configuration Reference](#configuration-reference); only newly-enrolled
  agents pick up a changed value.
- Tamper lockout is userland-only by design (see the "Tamper lockout"
  section above) — no kernel-level enforcement, so a local admin/root can
  always force-kill the process.
- [Speed Test](#speed-test) latency/jitter come from the M-Lab server's own
  TCP_INFO instrumentation relayed over the ndt7 websocket, not a local
  measurement — this is deliberate (works the same regardless of the
  node's OS) but means it reflects the server's view of the path, not a
  separately-measured client-side RTT.
- Home Assistant OS nodes only report a single primary IP, not the full
  network-interfaces list the Overview card shows for other platforms —
  the Supervisor's `/network/info` response isn't mapped to per-interface
  entries yet. Speed Test also isn't wired into `agent/internal/haosloop`
  at all yet, even though `internal/speedtest.Run` itself is
  platform-agnostic and could be reused directly.

## Resonance (embedded assistant)

Resonance is the suite's shared assistant. It mounts as a launcher in the bottom corner of every
authenticated page, but the assistant itself runs on the resonance server, not inside pktNode.
Configure it under **Settings → Resonance** (admin only); every field ships blank, so a fresh
install shows nothing until it is pointed at a resonance server of its own.

`app/integrations/resonance/` and `frontend/src/resonance/` are **vendored** — copied between
pkt\* apps byte-for-byte except for `APP_SLUG`. They are deliberately not a published package,
because `install.sh` builds a venv on customer hosts and a private index would put a credentialed
network dependency in the middle of every install. pktLog is the reference implementation.

```
browser                 pktNode                       resonance
embed.js  ──GET──▶  /api/resonance/code  ──POST──▶  /embed/session
          ◀─code──                        ◀─code───
frame ──────────────────────────────────────────────▶  /embed?c=<code>
```

pktNode vouches for whoever is signed in and receives a short-lived, single-use code. The key is
encrypted at rest, never reaches the browser, and resonance never sees a pktNode credential.
`GET /api/resonance/code` is the one cookie-authenticated route in the app — `embed.js` fetches it
itself, outside the SPA, and the access token lives in memory — so `Sec-Fetch-Site` and `Origin`
are both checked before the cookie is honoured.

**The data surface.** Two documents let resonance discover what it may call, both public because
they carry names rather than data:

| path | what it is |
|---|---|
| `/.well-known/resonance.json` | the grant — the operations this install permits |
| `/api/resonance/openapi.json` | those operations' OpenAPI, narrowed from the app's own |
| `/api/resonance/docs` | the shipped guides, for resonance to ingest (suite token or admin) |

Point resonance's **READ SPEC** at `/api/resonance/openapi.json`. The published operations are:

- `getNodeSummary`
- `listNodes`
- `getNode`
- `listNodeDisks`
- `searchNodeSoftware`
- `listAlertEvents`
- `listAlertRules`
- `searchApplicationLog`
- `ackAlertEvent`  *(writes)*
- `ackAllAlertEvents`  *(writes)*
- `toggleAlertRule`  *(writes)*

Every call is made by pktNode's own page, same-origin, on the session of the person already signed
in, so nothing here reaches data that person could not already open. Which operations exist is
fixed in `app/api/resonance_data.py`, not configurable per install. Write operations are withheld
from the grant entirely until an administrator sets a role to **Read and write**.

**Never exposed:** the running-process list, agent and enrolment tokens, and a node's override secret. Nothing here queues a command to an agent, runs a speed test, enrols or deletes a node, or edits a group.

## Log Forwarding

pktNode writes its own application log to the in-app **Logs** page. It can also
ship that log to a syslog collector — normally **pktLog**, which listens on
port `5514` — so this app's events sit alongside the rest of the estate.

Settings keys (Settings → Data → Log Forwarding in apps that expose the UI;
otherwise via `PUT /api/settings`):

| Key | Default | Meaning |
|---|---|---|
| `log_forward_enabled` | `false` | Turn forwarding on |
| `log_forward_host` | `""` | Collector hostname or IP |
| `log_forward_port` | `5514` | pktLog's syslog port |
| `log_forward_protocol` | `udp` | `udp` or `tcp` |
| `log_forward_level` | `INFO` | Minimum level forwarded |
| `log_forward_app_name` | `pktnode` | APP-NAME in the syslog message |

Admin endpoints:

- `GET  /api/system/log-forward/status` — delivery counters (sent, dropped, errors)
- `POST /api/system/log-forward/test` — send one test line without saving settings
- `POST /api/system/log-forward/reload` — apply settings changes without a restart

**Format is RFC 5424, deliberately.** pktLog parses both 3164 and 5424, but
3164 timestamps carry no timezone and the collector has to guess the offset —
which has produced wrong timestamps in this suite before. 5424 carries a full
offset, so there is nothing to guess.

**Delivery is fire-and-forget** on a background thread, with counters. Log
forwarding must never block or crash the thing it observes: a dropped line is a
nuisance, a stalled collector loop is an outage. If the collector is
unreachable, lines are dropped and counted rather than raised.

### If forwarded logs never arrive

**pktLog drops syslog from sources that are not registered.** Its
`collector_registry` gates what is allowed to persist, so the sending host's IP
must be present *and enabled* under pktLog's Settings → Collectors. Until then
the messages are accepted on the wire and silently discarded — the sender sees
a successful send either way, because UDP cannot tell it otherwise. pktLog also
caches that registry for five minutes, so a newly enabled source is not live
immediately.

Use the **Send test message** button (or the `test` endpoint) to confirm the
path end to end rather than assuming it works.

## The pkt suite

**pktNode** is one of ten apps in the pkt suite — self-hosted tooling for network
and security operations. Each installs and runs standalone, so take only the ones
you need; they share one architecture (FastAPI + React), one look, one
`admin`/`analyst`/`viewer` role model, and a suite token that lets siblings read
one another's data. Default ports don't collide (8760–8769), so any combination
runs on a single host.

| App | Port | What it does |
|---|---|---|
| **[pktFlow](https://github.com/bsnwgit/pktflow)** | `8766` | NetFlow, sFlow and IPFIX collection — flow search, traffic analytics, geo and topology views |
| **[pktSNMP](https://github.com/bsnwgit/pktsnmp)** | `8767` | SNMP polling and trap receiving for any OID — device health and metric history without a full NMS |
| **[pktLog](https://github.com/bsnwgit/pktlog)** | `8768` | Syslog over UDP, TCP and TLS — parsing, enrichment, full-text search and forwarding |
| **[pktPCAP](https://github.com/bsnwgit/pktpcap)** | `8765` | Packet capture analysis in the browser — drop in a `.pcap` for TCP, DNS and threat findings, no Wireshark install |
| **[pktWiFi](https://github.com/bsnwgit/pktwifi)** | `8769` | Access point, RF and client visibility from Meraki and UniFi controllers or plain SNMP polling |
| **[pktIPAM](https://github.com/bsnwgit/pktipam)** | `8761` | IP address management reconciling declared subnets against live DHCP, DNS and device data, flagging conflicts |
| **pktNode** *(you are here)* | `8764` | Endpoint monitoring and management for Mac, Windows and Linux via a lightweight Go agent |
| **[pktSecurity](https://pktsolution.com/pktSecurity/index.html)** | `8762` | Security operations across the estate — CVE exposure, threat intelligence, ATT&CK-mapped detections and case management |
| **[pktCert](https://github.com/bsnwgit/pktcert)** | `8763` | TLS certificate discovery and expiry tracking, plus an internal CA — issue, revoke and serve CRLs |
| **[pktHub](https://github.com/bsnwgit/pkthub)** | `8760` | The front door — one sign-in, one alert stream, NOC wallboards and user management across every registered app |

[pktHub](https://github.com/bsnwgit/pkthub) is optional — it registers the others
and puts them behind a single login with shared alerting and NOC wallboards — but
every app is fully usable without it.

More at **[pktsolution.com](https://pktsolution.com)**.
