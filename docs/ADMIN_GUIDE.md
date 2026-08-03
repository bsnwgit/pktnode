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

## Users & roles

Admin and analyst can queue commands, open Live Terminal, and bulk-manage nodes; only admins reach Enrollment, Settings, Override Code, and decommission/delete actions. Manage accounts at Settings → Security → Users.

## Enrollment

1. Enrollment page → **New Token**. Optional label, expiry, and max-use count (1 for a single machine, unlimited for a shared rollout token). The raw token is shown once; use **Get Install Command** on the token's row later if you need it again (generates a fresh token with the same label/limits).
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

### What gets collected

Every check-in: CPU/memory/disk %, uptime, current logged-in user, primary IP. Every 15th check-in: full software inventory, running-process snapshot, network interfaces, listening ports, and host firewall status (replaced wholesale, not appended to history).

### Security signals (agent 0.2.0+)

Every full-inventory check-in also reports listening TCP/UDP ports (with owning process where resolvable) and a best-effort firewall status (`enabled`/`disabled`/`unknown` — `unknown` on Linux hosts running bare iptables/nftables with no `ufw`/`firewalld` front-end). Both show on a node's **Security** tab.

This is the same data pktSecurity's `pktnode_suite` asset collector consumes when configured against this server — open ports feed its exposed-service risk scoring directly, no extra configuration needed on either side once the node reports them. Firewall status is currently informational only (visible on the node and passed through to pktSecurity) — nothing scores risk or compliance on it yet.

**Agents enrolled before 0.2.0 report neither field until reinstalled** — there's no agent self-update mechanism, so pick a node's row on the Enrollment page and re-run its install command to upgrade it in place (re-enrolling reuses the same node record rather than creating a duplicate, as long as the machine's hardware serial hasn't changed).

## Remote actions

Queue `restart_service`, `kill_process`, `reboot`, `shutdown` from a node's detail page or in bulk from Nodes. Applied on the node's next check-in (bounded by the check-in interval, not instant). The API also still accepts `run_script`, and the agent still executes it, but it isn't currently exposed in the Queue Command modal — use **Live Terminal** for ad-hoc one-off commands instead.

## Live Terminal

A real interactive shell, opened via a persistent outbound WebSocket the agent keeps open (separate from its periodic HTTP check-in) — the server relays between that and an admin's browser session. The node never accepts an inbound connection of any kind, so no firewall changes are needed on the managed machine. A second admin opening a terminal on the same node preempts (doesn't queue behind) the existing session. If the node has no live control-channel connection (agent offline, or an older build predating this feature), the button reports that plainly.

## Messaging (tray chat)

Two-way chat via the Messages tab, delivered through the tray helper on the node. Bounded by the check-in interval in both directions — no live push. **A node with no tray helper running can't be messaged at all**, enforced server-side, not just hidden in the UI (`has_tray` is reported on every check-in; always `false` on headless Linux, and on Linux generally until a tray build ships for it).

## Tray helper (status icon)

A small per-user process (separate from the root/SYSTEM agent service, since root/SYSTEM can't draw UI on any of the three OSes) shows online/offline status and last check-in in the system tray, reading a world-readable `status.json` the agent writes after each check-in — no network access or credentials of its own. Installed automatically when a tray build exists for the target OS/arch (not every target has one — Linux needs a native GTK3/libappindicator3-dev build, and Windows/arm64 has no ready cgo cross-toolchain today). The tray's only real interactive item is **Stop Agent…**, gated by the override code below — there's no way to quietly kill just the icon.

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

Four built-in rule types, evaluated every 60 seconds: `node_offline`, `disk_low`, `cpu_high`, `mem_high`. Manage rules (thresholds, severity, channels, cooldown) on Alerts → Rules — you can have more than one rule of the same type at different severities/thresholds. Notification channels (Slack/Email/PagerDuty/Webhook/TraceCat) are configured under Settings → Notifications.

## Backup & Restore

Configure schedule and rotation at Settings → Data → Backups. Each snapshot is a timestamped directory containing `pktnode.db` + `config.yaml`.

**Restoring:**
- Every listed snapshot has a **Restore…** link — restores directly from that on-server snapshot, no download/upload needed. Expanding it shows a checkbox per file present, so you can restore just the DB or just the config instead of both together.
- A full bundle can also be exported/imported as a `.tar.gz`, with the same per-file selection on upload.
- Restoring requires a service restart to pick up `config.yaml` changes. Existing agents keep working against a restored server unchanged, since their bearer tokens live in the restored DB.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u pktnode -n 50`; check `config.yaml` and secret key |
| A node never comes online after install | Confirm the install command reached the machine and that it can reach the server URL over the network; check the enrollment token hasn't expired or hit its use limit |
| Live Terminal reports no connection | Agent may be offline, or predates this feature — rebuild/update the agent |
| Messages tab shows a warning and no send box | That node has no tray helper running (or is headless Linux, or Linux without a tray build) |
| A restored `config.yaml` didn't take effect | Restart the service — restoring never does this automatically |

## Upgrading

Pull the latest server code, rebuild the frontend if you build manually, then restart the service. Rebuild and redistribute agent binaries separately (`agent/build.sh`) if the agent itself changed — existing agents keep running their current version until manually updated/reinstalled.
