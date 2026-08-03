# pktNode — User Guide

This guide is for people who use pktNode to monitor and manage enrolled endpoints day-to-day — not for installing or administering the server. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for setup, users, backups, and enrollment infrastructure.

## Logging in

Log in with your username and password, or Okta SSO if configured.

## Navigation

**Dashboard**, **Nodes**, **Enrollment** (admin only), **Alerts**, **Logs**. **Settings** appears only for admins.

## Dashboard

Clickable tiles for total/online/offline/stale/pending node counts and active alert count — each jumps to the corresponding filtered view — plus a table of the 10 most recently checked-in nodes.

## Nodes

The full inventory. Filter by status (All/Online/Offline/Stale/Pending/Decommissioned) or search by hostname. If your role is admin or analyst, use the checkbox column to select multiple nodes and either **bulk reboot/shut down** them (queued, applied on each node's next check-in) or **bulk-assign them to a group**.

### Node detail

Click any node for tabs covering Overview (hardware, IP, current logged-in user, network interfaces, group membership), Software (installed packages), Processes (running processes, with a per-row **Kill** action), Security (listening ports and the host's firewall status — see below), Metrics (CPU/mem/disk history), Commands (remote-action history), and Messages (chat with whoever's logged into the node).

Admins and analysts get two action buttons:

- **Live Terminal** — an instant, interactive shell on the node. Nothing is queued or logged — it's a real live session. If someone else opens a terminal on the same node, your session is preempted and closed with a notice.
- **Queue Command** — fire a fixed remote action (Restart service, Kill process, Reboot node, Shutdown node) and watch it move from pending → sent → completed/failed live in the same modal. Every queued command lands in the Commands tab too. Commands are picked up on the node's next check-in, so expect up to about a minute of latency — this isn't instant like Live Terminal.

Admins additionally get **Override Code** (for locally stopping/uninstalling the agent on that machine — see your admin if you need this) and decommission/delete actions.

### Security tab

Shows the node's currently listening TCP/UDP ports (with the owning process where known) and a firewall status badge (Enabled/Disabled/Unknown). This is collected the same way as Software/Processes — refreshed on the node's periodic full-inventory check-in, not live. A node showing no data here either hasn't reported a full inventory yet, or is still running an older agent build from before this feature existed — see your admin about reinstalling the agent on it.

### Messaging a node

The Messages tab is a simple chat thread with whoever is logged into that node, delivered through the tray helper running on their machine. **A node with no tray helper running can't be messaged at all** — you'll see a warning banner and the send box will be hidden. Delivery in both directions is bounded by the check-in interval — there's no live push, so expect a short delay, and the tab refreshes every 10 seconds while open.

## Enrollment (admin only)

Issue and manage enrollment tokens used to add new machines. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for the full enrollment procedure.

## Alerts

Built-in alert types: node offline, low disk space, high CPU, high memory. Ack/resolve if your role allows; alerts auto-resolve once the condition clears.

## Logs

The server's own application log, browsable in-app.

## Looking up an IP address

Any IP shown in the app is clickable, opening a lookup using your own per-user API keys (Settings → User Keys).

## Getting help in the app

Click **Documentation** in the sidebar (just above your account info) to open this guide and the Administrator Guide as in-app tabs, so you don't need the repo checked out to read them.

## The tray icon (if installed on your machine)

If you're a regular user on a managed machine (not an admin operating pktNode), you may see a small pktNode icon in your menu bar or system tray. It shows whether the agent is checking in successfully and the configured server URL — it has no shortcut into the admin web UI, and it's not something you interact with day-to-day beyond receiving the occasional native OS dialog if an admin sends you a message.
