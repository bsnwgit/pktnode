# pktNode — Administrator Guide

Covers installing, configuring, and operating pktNode, plus enrolling and managing endpoint agents. For day-to-day usage (Nodes, Alerts), see [USER_GUIDE.md](USER_GUIDE.md). See the [README](../README.md) for the full technical reference.

## Installation

```bash
git clone git@github.com:bsnwgit/pktnode.git
cd pktnode
bash install.sh
```

Prompts for install directory and port (default `8764`), handles the venv, `config.yaml` + secret key, DB setup, admin user, frontend build, and systemd service. Log in with the printed admin credentials.

## First-time setup checklist

1. **Change the admin password.**
2. **Build agent binaries** if you haven't already (`cd agent && ./build.sh` — cross-compiles for macOS/Linux/Windows, amd64+arm64, into `../agent-releases/`, which the server serves at `/agent-releases/<binary>` for the installer scripts).
3. **Issue an enrollment token** (Enrollment page, admin-only nav item) and enroll your first node — see Enrollment below.
4. **Set up groups** (Settings → Groups) if you want per-group alert overrides or bulk actions organized by fleet segment.
5. **Configure alert rules and notification channels.**
6. **Set up backups** and confirm a manual run succeeds.
7. **Create accounts** for your team.

## Finding your way around Settings

Settings has a section bar above its tab bar with two buttons:

- **pktNode** — Groups. (Enrollment, the other pktNode-specific area, is a top-level nav item, not a Settings tab.)

Only the selected section's tabs appear in the row below. Deep links to a tab select the right section automatically.

## Users & roles

Admin and analyst can queue commands, open Live Terminal and File Transfer, and bulk-manage nodes; only admins reach Enrollment, Settings, Override Code, and decommission/delete actions. Manage accounts at Settings → Security → Users.

## Enrollment

1. Enrollment page → **New Token**. Optional label, expiry, and max-use count (1 for a single machine, unlimited for a shared rollout token). The raw token is shown once; use **Get Install Command** on the token's row later if you need it again (generates a fresh token with the same label/limits, since a token with a finite max-use count is deleted outright the moment its last use is consumed — see below — rather than sitting around exhausted).
2. Run the install command on the target machine:

```bash
# macOS / Linux
curl -fsSL http://<server>:8764/install-agent.sh | sudo bash -s -- --server http://<server>:8764 --token <token>
```

```powershell
# Windows (elevated PowerShell)
iwr http://<server>:8764/install-agent.ps1 -UseBasicParsing | iex
Install-PktNodeAgent -Server "http://<server>:8764" -Token "<token>"
```

The installer downloads the matching binary, exchanges the enrollment token for a per-node bearer token (never reused after this step), installs a native service, and starts checking in. Manual CLI equivalents exist (`pktnode-agent install/uninstall/unlock/run/version`) if you need to script it differently.

A token with a finite max-use count (including the common `1`, single-machine case) is **deleted outright — not just marked revoked — the instant its last use is consumed**; it never lingers in the Enrollment list as a spent, no-longer-useful row that could be mistaken for still valid. A daily background sweep also deletes any token that's expired, or that's sat completely unused past its expiry, so an abandoned token doesn't linger either. Unlimited tokens (shared rollout links) are the deliberate exception and stick around for repeated use.

Re-running the install command on a machine that's already enrolled (to upgrade an old agent, for example) reuses that node's existing identity rather than creating a duplicate row — the agent keeps its local UUID stable across a reinstall as long as its config file survives, which is what the server matches on.

### What gets collected

Every check-in: CPU/memory/disk %, network throughput (in/out Mbps), uptime, current logged-in user, primary IP. Every 15th check-in: full software inventory, running-process snapshot, network interfaces, listening ports, host firewall status, and per-volume disk usage (all replaced wholesale, not appended to history).

### Security signals (agent 0.2.0+)

Every full-inventory check-in also reports listening TCP/UDP ports (with owning process where resolvable) and a best-effort firewall status (`enabled`/`disabled`/`unknown` — `unknown` on Linux hosts running bare iptables/nftables with no `ufw`/`firewalld` front-end). Both show on a node's **Security** tab.

This is the same data pktSecurity's `pktnode_suite` asset collector consumes when configured against this server — open ports feed its exposed-service risk scoring directly, no extra configuration needed on either side once the node reports them. Firewall status is currently informational only (visible on the node and passed through to pktSecurity) — nothing scores risk or compliance on it yet.

**Agents enrolled before 0.2.0 report neither field until updated** — see **Updating agents** under Remote actions below, or re-run the install command per Upgrading.

### Disk tools (agent 0.8.0+)

A node's Utils → Disk Tools subtab queues three on-demand actions the same way as any other remote action (pending → sent → completed/failed, results retained on the tab): `disk_largest_files` (scans the node's primary volume, filesystem-boundary aware so it doesn't wander into virtual mounts like `/proc`), `disk_cleanup_temp` (dry-run preview, then a real deletion pass, both age-bounded), and `disk_health_check` (SMART status via `smartctl` where available). Not queued or scheduled automatically — an admin/analyst triggers each run. Hidden entirely on Home Assistant OS nodes, which have no filesystem access to run them against.

## Platform support

### Unraid

The agent detects an Unraid host at runtime (`/etc/unraid-version`) and installs itself the normal way, with two Unraid-specific pieces:

- **FAT32 `/boot` workaround** — `/boot` is FAT32-mounted without exec permission, so the canonical binary lives there but a refreshed, executable copy is maintained at `/usr/local/pktnode-agent/` on every launch (`refreshRunCopy`); this is transparent to normal operation.
- **Persistence across reboots** — a guarded block is added to `/boot/config/go` (Unraid's own boot-hook file) so the agent's supervisor process (`pktnode-agent supervise`) starts automatically on every boot, since Unraid has no systemd.

Nodes reporting `os_type: unraid` get an extra **Unraid** tab in the UI: array/parity status and per-disk roster (parsed from Unraid's own `emhttp` state files), Docker container inventory with start/stop/restart control, and libvirt VM inventory with start/stop/restart control — all queued through the same command mechanism as other remote actions. Software inventory reads Unraid's native Slackware package database (`/var/log/packages`) rather than the deb/rpm formats used elsewhere.

Uninstalling on Unraid goes through the same tamper-lockout unlock flow as any other platform.

### Home Assistant OS

Rather than a native OS install, the agent runs as a Home Assistant **Supervisor Add-on** (Docker-based, built from `homeassistant-addon/pktnode-agent/`) — it's the same `pktnode-agent` binary and version as every other platform, it just detects `SUPERVISOR_TOKEN` at startup and switches to collecting through the Supervisor's REST API instead of native OS calls, since a Supervisor add-on has no direct host access.

**Install:**

```bash
curl -fsSL http://<server>:8764/install-haos-addon.sh | bash -s -- --server http://<server>:8764
```

Run this from the Home Assistant host's shell (SSH add-on, or direct SSH to the HAOS box). It stages the add-on files into `/addons/local/pktnode-agent/` and downloads the matching binary from `/agent-releases/`. Then in the Home Assistant UI: **Settings → Add-ons → Add-on Store → check for the "pktNode Agent" local add-on → Install**, set **Server URL** and **Enrollment Token** in its Configuration tab, and **Start**. The Enrollment page's install-command panel (OS dropdown → Home Assistant OS) has the same command plus copyable Server URL/token values.

**Known platform limitations** (Supervisor API has no equivalent, not an agent bug):
- **Processing and Security tabs report no data** — no process-list or ports/firewall API on the Supervisor.
- **Disk Tools and Speed Test aren't available** — no filesystem access for the former; the latter isn't wired up for HAOS yet.
- **CPU/memory are an approximation** — summed from Home Assistant Core + Supervisor + every add-on's own reported container stats (`cpu_percent`/`memory_usage`/`memory_limit` from `/core/stats`, `/supervisor/stats`, `/addons/<slug>/stats`), not a true whole-host reading.
- Reboot/shutdown route through `/host/reboot` and `/host/shutdown`; Docker start/stop/restart commands are interpreted as add-on slugs and route through `/addons/<slug>/{start,stop,restart}`.

**Add-on Store caching gotcha**: after updating add-on files on the box (a reinstall, or picking up a new version), the Store's local-add-on listing can go stale in either direction — it may not show the new files, or it may keep showing a listing whose files are already gone ("Dockerfile is missing" on install). **Settings → System → Restart → Restart Home Assistant** (not just the add-on) reliably clears this.

## Remote actions

Queue `restart_service`, `kill_process`, `reboot`, `shutdown`, `update_agent` from a node's detail page or in bulk from Nodes; Unraid and Home Assistant OS nodes additionally accept `docker_start`/`docker_stop`/`docker_restart` (container or add-on, by name/slug) and, on Unraid, `vm_start`/`vm_stop`/`vm_restart`. Applied on the node's next check-in (bounded by the check-in interval, not instant, unless followed by a Check In Now push). The API also still accepts `run_script`, and the agent still executes it, but it isn't currently exposed in the Queue Command modal — use **Live Terminal** for ad-hoc one-off commands instead.

### Updating agents (push, agent 0.2.0+)

No more manual reinstalling to roll out a new agent build. The Nodes page shows **Latest agent: vX.Y.Z** (read from `agent-releases/VERSION`, written automatically by `agent/build.sh`) next to an **Update N outdated agents** button that pushes to every active node not already on that version. Select specific nodes instead and use **Update Agent** in the bulk-action bar to push to just those, regardless of their current version. A single node's own Overview tab also gets an inline **Update to vX.Y.Z** link next to its Agent version whenever it's behind, plus "Update agent" in that node's Queue Command modal for a one-off, deliberate push.

Under the hood this queues the same kind of command as reboot/shutdown (`update_agent`) — the agent downloads the release binary matching its own OS/arch from `/agent-releases/`, atomically swaps it in over its own running binary, and restarts itself (systemd/launchd relaunch it automatically; the Windows service is explicitly restarted via a short-delayed helper, since SCM won't auto-restart a clean stop). All of this goes through the same tamper-lockout authorization path as an admin-initiated stop, so it doesn't require touching the machine's override code — the push itself is the authorization.

**The tray helper comes along automatically if one's already installed (agent 0.3.0+)** — same download-and-swap, then a best-effort relaunch. macOS can restart it live (`launchctl kickstart -k`, since the tray's LaunchAgent has no `KeepAlive`); Linux/Windows have no equivalent live-restart mechanism (XDG autostart / per-login "Run" key), so on those the new tray binary takes effect at the user's next login instead. This never installs a tray where one wasn't already present. **Agents on 0.2.0 (which already understand `update_agent` itself) predate this specific part** — they'll still update their own binary correctly, they just won't bring the tray along; get them onto 0.3.0+ once (a push works fine for the agent binary itself) and every push after that also refreshes the tray.

**Only agents already on 0.2.0+ understand `update_agent`** — an older agent just reports the command as unknown and stays on its current build. Get those onto 0.2.0+ once via the normal install-command reinstall (Enrollment page → node row → **Get Install Command**); every push after that works.

## Speed Test

A node's Utils → **Speed Test** subtab runs a real download/upload/latency test over M-Lab's NDT7 protocol — no API key, no bundled external binary, a nearby measurement server is auto-discovered each run. **Run Speedtest Now** queues it through the same command mechanism as Remote Actions above (pending → sent → completed/failed). For an unattended schedule, set **Settings → General → Speedtest schedule** (hours, `0` = off) — unlike the check-in interval, this setting takes effect on already-running agents on their very next check-in, no re-enroll needed. Only one test runs per node at a time; a collision between a scheduled run and a manual one is skipped, not queued. Every run (including failures) lands in the Speed Test subtab's history table with download/upload Mbps, latency/jitter, and which server was used. **Agents enrolled before this feature shipped need reinstalling to pick it up**, same limitation as Security signals above. Not available on Home Assistant OS nodes yet — see Platform support above.

## Live Terminal

A real interactive shell, opened via a persistent outbound WebSocket the agent keeps open (separate from its periodic HTTP check-in) — the server relays between that and an admin's browser session. The node never accepts an inbound connection of any kind, so no firewall changes are needed on the managed machine. A second admin opening a terminal on the same node preempts (doesn't queue behind) the existing session. If the node has no live control-channel connection (agent offline, or an older build predating this feature), the button reports that plainly.

## File Transfer (agent 0.9.0+)

A remote file browser — navigate directories, upload/download files (drag-and-drop or a picker), create folders, rename, and delete — opened via **File Transfer**, next to Live Terminal on a node's detail page. It rides the same always-open control channel Live Terminal uses, as a second, independent session, so the two can be open on the same node at once without either preempting the other; a second admin opening File Transfer on the same node preempts only the existing *file* session, not any terminal session. 500 MB cap per file — it's built for configs, logs, and installers over chunked JSON/base64 frames, not bulk transfers. The initial listing lands in the node's home directory (agent 0.9.1+), with a **Root** breadcrumb to browse the whole filesystem from there.

**Important — macOS's sealed System volume will reject writes there, and this is correct, expected OS behavior, not a bug.** Since Big Sur, macOS's `/`, `/System`, `/bin`, `/sbin`, and `/usr` (excluding `/usr/local`) live on a cryptographically signed, read-only System volume — enforced by signature verification, not a Unix permission bit, so **nothing run in a normal session can write there, at any privilege level**. `sudo scp` over Live Terminal hits the identical "read-only file system" error File Transfer would show for the same path, because both are ordinary userland processes on the running OS. The only way to write to that volume requires booting into macOS Recovery Mode and running `csrutil authenticated-root disable`, then rebooting — local/physical console access, not something reachable through Live Terminal or File Transfer. Tell users hitting this to navigate into the home directory (the default) or another writable location — `/Users/...`, `/Library`, `/Applications`, `/private/tmp`, `/private/var` — all of which are firmlinked to the writable Data volume and work normally. Linux and Windows nodes have no equivalent volume-level restriction; ordinary filesystem permissions are all that apply.

Agents older than 0.9.0 keep their control channel open (Live Terminal still works) but have no case for the file transfer protocol, so a File Transfer session just sits at "Connecting…" indefinitely with no error — push an agent update (see **Updating agents** above) to fix it.

## Check In Now (agent 0.3.0+)

The same always-open control channel that powers Live Terminal also carries a lightweight "check in right now" push — **Check In Now** on a node's detail page, next to Live Terminal. It skips the rest of that node's current check-in interval instead of waiting it out, which is what makes a just-queued command (including `update_agent`) or a fresh inventory snapshot show up immediately instead of after a wait bounded by the check-in interval. Same reachability requirement as Live Terminal — a node with no live control-channel connection reports that plainly rather than silently doing nothing. **Agents older than 0.3.0 keep their control channel open (Live Terminal still works) but silently ignore this specific push** — harmless, it just means the button has no visible effect until that node is updated once.

## Tray helper (status icon)

A small per-user process (separate from the root/SYSTEM agent service, since root/SYSTEM can't draw UI on any of the three OSes) shows online/offline status and last check-in in the system tray, reading a world-readable `status.json` the agent writes after each check-in — no network access or credentials of its own. Installed automatically when a tray build exists for the target OS/arch (not every target has one — Linux needs a native GTK3/libappindicator3-dev build, and Windows/arm64 has no ready cgo cross-toolchain today). Its **About pktNode Agent** item shows the agent's version, server URL, check-in interval, and current status. Its only other interactive item is **Stop Agent…**, gated by the override code below — there's no way to quietly kill just the icon.

## Tamper lockout (override code)

Stopping/restarting/uninstalling the agent through the OS service manager or CLI requires a live, offline-verified 6-digit TOTP code (RFC 6238, 30-second window) derived from a secret issued at enrollment. Read the current code from a node's detail page (**Override Code**, admin-only). This works with no network path to the server at all, since verification is entirely local.

- `pktnode-agent uninstall --unlock-code <code>` checks inline.
- For a plain service-manager stop: `pktnode-agent unlock <code>` first (grants a 2-minute window), then `systemctl stop`/`launchctl stop`/`Stop-Service` — without the unlock, the service appears to hang rather than exit.

**Honest limit**: this is userland-only, no signed kernel component. A local root/admin user can always force it with `kill -9` or Task Manager. It stops the casual/GUI-level disable path, not a determined local admin — that's true on any OS without a kernel driver.

## Groups and alert overrides

Groups are created/deleted only at Settings → Groups (admin only) — a device's own page just picks from that existing list, enforced server-side. Assign a device to one or more groups from its own page, or in bulk from the Nodes list.

Alert on/off state (and, for threshold-based rule types, the threshold itself) resolves through a 3-level override chain, most specific wins:

1. **Per-device** (`node_offline` only) — a node's Overview tab has a *Host down alerts* dropdown: Inherit / Always alert / Never alert. Use this for one machine that's routinely expected to go offline (e.g. shut down nightly) without touching the rule or creating a group.
2. **Per-group** (all four rule types, plus threshold overrides) — set at Settings → Groups, by specific rule (not just by type, since you can have more than one rule of the same type at different thresholds).
3. **The rule's own default** — `alert_host_down_enabled` (Settings → General) for `node_offline`; each rule's own `threshold_pct` for the others.

If a device is in two groups with conflicting settings for the *same field* of the *same rule*, whichever was saved most recently wins; non-overlapping fields from both groups apply together. Turning an alert off at any level auto-resolves any already-open event for it. Deleting a group strips it from every device in it and drops its overrides.

## Alerting

Four built-in rule types, evaluated every 60 seconds: `node_offline`, `disk_low`, `cpu_high`, `mem_high`. Manage rules (thresholds, severity, channels, cooldown) on Alerts → Rules — you can have more than one rule of the same type at different severities/thresholds. Notification channels (Slack/Email/PagerDuty/Webhook/TraceCat) are configured under Settings → Notifications. Deleting a node (Overview → **Delete Permanently**) auto-resolves any of its still-open alert events first, so it can't leave a stuck "offline" alert behind with nothing left to auto-resolve it.

## Backup & Restore

Configure schedule and rotation at Settings → Data → Backups. Each snapshot is a timestamped directory containing `pktnode.db` + `config.yaml`.

**Restoring:**
- Every listed snapshot has a **Restore…** link — restores directly from that on-server snapshot, no download/upload needed. Expanding it shows a checkbox per file present, so you can restore just the DB or just the config instead of both together.
- A full bundle can also be exported/imported as a `.tar.gz`, with the same per-file selection on upload.
- Restoring requires a service restart to pick up `config.yaml` changes. Existing agents keep working against a restored server unchanged, since their bearer tokens live in the restored DB.

## Resonance (embedded assistant)

Settings → Resonance (admin only). Adds an assistant launcher to the bottom corner of every page. The assistant itself runs on the resonance server; pktNode only decides who may open it.

**Setting it up.** Paste the **interface server** address — not resonance's admin portal, which answers on a different address and serves `embed.js` too, so it looks right until the session call returns "not found" — then the key you were issued. Choose which roles may use it, press **Test Connection**, and only then switch **Enabled** on. Test Connection works whether or not the feature is enabled; always prove a key before putting the widget in front of users. Every field ships blank, so a fresh install shows nothing until it is pointed at a resonance server of its own.

Two things have to line up on the resonance side, and both fail silently when they don't:

- **This install's origin** must be on the key's allow-list. The exact string is shown ready to copy on the same page. Behind a reverse proxy, fill in **pktNode's own address** yourself — what the app detects is the internal address, not the one users type.
- **Speakers Name** must be on for the key. Without it resonance records nothing, so there is no trace of who asked what.

**Reachability, twice over.**

- Resonance must be reachable **from the browser**, over HTTPS, with a certificate those browsers already trust. An untrusted certificate produces an empty widget and nothing in the console to explain it.
- pktNode also calls resonance **server to server**, so this host must resolve resonance's name and trust its certificate — the browser doing both is not enough. Python verifies against its own bundled roots rather than the system store, so a certificate signed by an internal CA is trusted by every browser on the network and still rejected here. Point **CA bundle** at the system store instead (`/etc/ssl/certs/ca-certificates.crt` on Debian and Ubuntu).

**What it can reach.** The managed hosts and one in full, their filesystems, the installed-software inventory, the estate summary, alert rules and the alerts they have fired, and pktNode's own diagnostic log. Every call is made by pktNode's own page on the session of whoever is signed in, so it reaches only what that person could already open in the interface. Which operations exist is fixed in the code, not configurable per install — `/.well-known/resonance.json` lists exactly what is on offer, and needs no login to read because it contains names, not data.

**What it can never reach**, at any role level: the running-process list, which is the most sensitive thing this application holds and answers no question an assistant should be asked; and any agent token, enrolment token or node override secret. Those columns are not selected, so they cannot arrive through a schema's `extra` either. Nothing the assistant can call queues a command to an agent, runs a speed test, enrols or deletes a node, or edits a group.

Documentation is published separately at `GET /api/resonance/docs`, to a suite token or an admin session — the guides shipped with the running version, so pointing resonance at it keeps the assistant's knowledge in step with the installed release instead of describing last year's UI.

**What each role can do.** Set per role. *No access* hides the launcher entirely. *Read only* lets the assistant look at the operations above. *Read and write* also lets it act — and adds exactly three things, no more: acknowledge one alert, acknowledge all of them, and switch an existing alert rule on or off. There is no delete of anything and no creating or editing of configuration. Resonance stops and reads the actual values back to the person before it runs any of them.

**A level never exceeds the role.** Two checks have to agree: the level set here, and pktNode's own rule for the thing being done. Setting a level grants nobody a right they did not already have — it decides whether the assistant may use the rights they do.

Where no role is set to *Read and write*, the write operations are withheld from the published grant altogether, so there is nothing at the resonance end that could be turned on. Every write the assistant performs is recorded in the application log with who asked for it.

**Credentials.** pktNode never sends a login to resonance. It vouches for whoever is signed in and gets back a short-lived, single-use code the browser spends on opening the panel. The key is encrypted at rest and never reaches the browser.

**If it never appears.** Diagnostics reports how many users could not load the widget in the last week; the usual causes are an ad blocker, a wrong server address, or resonance being unreachable. Repeated failures pause the integration for a few minutes rather than hammering resonance — the panel says so while it is paused, and a successful Test Connection clears it.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u pktnode -n 50`; check `config.yaml` and secret key |
| A node never comes online after install | Confirm the install command reached the machine and that it can reach the server URL over the network; check the enrollment token hasn't expired or hit its use limit |
| Live Terminal reports no connection | Agent may be offline, or predates this feature — rebuild/update the agent |
| File Transfer stuck on "Connecting…" | Agent predates 0.9.0 — update it (Live Terminal working on the same node confirms the control channel itself is fine) |
| File Transfer says "read-only file system" on macOS | Expected — that path is on the sealed System volume (root, `/System`, `/bin`, `/sbin`, `/usr`); no privilege level can write there outside Recovery Mode. Navigate to the home directory or another writable location instead |
| A restored `config.yaml` didn't take effect | Restart the service — restoring never does this automatically |
| HAOS add-on install fails with "Dockerfile is missing" | Add-on Store listing is stale — **Settings → System → Restart → Restart Home Assistant**, then reinstall |
| Unraid agent won't survive a reboot | Check `/boot/config/go` has the pktNode block — reinstalling repairs it |

## Upgrading

Pull the latest server code, rebuild the frontend if you build manually, then restart the service. If the agent itself changed, rebuild release binaries with `agent/build.sh` (this also refreshes `agent-releases/VERSION`) — agents on 0.2.0+ can then be updated with a push from the Nodes page instead of a manual reinstall; see **Updating agents** above. Agents older than 0.2.0 still need one manual reinstall to get onto a build that understands the push mechanism at all.
