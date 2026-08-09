# pktNode — User Guide

This guide is for people who use pktNode to monitor and manage enrolled endpoints day-to-day — not for installing or administering the server. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for setup, users, backups, and enrollment infrastructure.

## Logging in

Log in with your username and password, or Okta SSO if configured.

## Navigation

**Dashboard**, **Nodes**, **Enrollment** (admin only), **Alerts**, **Logs**. **Settings** appears only for admins.

## Dashboard

Clickable tiles for total/online/offline/stale/pending node counts and active alert count — each jumps to the corresponding filtered view — plus a table of the 10 most recently checked-in nodes.

## Nodes

The full inventory. Filter by status (All/Online/Offline/Stale/Pending/Decommissioned) or search by hostname. If your role is admin or analyst, use the checkbox column to select multiple nodes and either **bulk reboot/shut down** them (queued, applied on each node's next check-in), **bulk-assign them to a group**, **push an agent update**, or **Check In Now** them all — that last one pushes an immediate check-in over each selected node's live control channel instead of waiting for its next scheduled one, so a command you just queued (or a fresh agent update) shows up right away rather than after a wait. Next to the search box you'll also see the current **Latest agent** version and, if any node is behind it, an **Update N outdated agents** button that pushes to all of them in one click without needing to select anything first.

### Node detail

Click any node to open its detail page, organized into four main tabs, most with their own subtabs:

- **Overview** — hardware summary, IP, current logged-in user, network interfaces, group membership, and (for admins/analysts) an **Actions** card holding **Check In Now** plus, for admins, **Override Code**, **Decommission & Revoke**, and **Delete Permanently**.
- **System** → **Software** (installed packages), **Processing** (running processes, with a per-row **Kill** action), **Security** (listening ports and firewall status — see below), **Settings** (this node's group membership and its Host down alerts override).
- **Metrics** → **System** (CPU/mem/disk history) and **Network** (inbound/outbound throughput history — see below).
- **Utils** → **Commands** (remote-action history and **Queue Command**), **Storage** (per-volume disk usage), **Disk Tools** (largest-files scan, temp cleanup, disk health check — see below), **Speed Test** (download/upload/latency history — see below).

An Unraid node additionally gets an **Unraid** main tab (Array, Containers, VMs — see below). A Home Assistant OS node hides the Disk Tools subtab, since the platform gives the agent no filesystem access to run them — see Home Assistant OS below for what is and isn't available there.

Admins and analysts get a **Live Terminal** button in the page header — an instant, interactive shell on the node, nothing queued or logged, a real live session; if someone else opens a terminal on the same node, your session is preempted and closed with a notice. Next to it, **File Transfer** opens a remote file browser on the node — navigate folders, upload/download files, create folders, rename, delete — as its own independent live session, so it can be open at the same time as Live Terminal on the same node. **Check In Now**, in the Overview tab's Actions card, asks the node to check in right away instead of waiting for its next scheduled one — useful right after you've queued a command and don't want to wait out the check-in interval to see it land. All three need the node to have a live connection open (agent online, on a build new enough to support it); otherwise the button says so instead of just hanging.

**Uploading to a Mac node and getting "read-only file system"?** That's expected macOS behavior, not a bug. Since macOS Big Sur, the root of the filesystem (`/`) and core system folders (`/System`, `/bin`, `/sbin`, `/usr`) are sealed and read-only — nothing can write there, not even an administrator. File Transfer opens into the node's home directory by default for exactly this reason; if you've navigated elsewhere and hit this, go back to the home directory or another normal folder like `/Users/...`, `/Library`, `/Applications`, or `/private/tmp` instead. Linux and Windows nodes don't have this restriction.

The **Commands** subtab (under Utils) has its own **Queue Command** button (next to its search box, same spot as Speed Test's **Run Speedtest Now**) to fire a fixed remote action — Restart service, Kill process, Reboot node, Shutdown node, Update agent, and on Unraid/HAOS nodes also Start/Stop/Restart container (or VM, on Unraid) — and watch it move from pending → sent → completed/failed live in the same modal. Every queued command lands in that tab's history too. Commands are picked up on the node's next check-in (or right away if you hit Check In Now), so expect up to about a minute of latency otherwise — this isn't instant like Live Terminal.

Overview also shows the node's own **Agent version**, with an inline **Update to vX.Y.Z** link right next to it whenever the node is behind the latest available build — a one-click shortcut to the same push described above, without opening Queue Command.

### Security (System → Security)

Shows the node's currently listening TCP/UDP ports (with the owning process where known) and a firewall status badge (Enabled/Disabled/Unknown). This is collected the same way as Software/Processing — refreshed on the node's periodic full-inventory check-in, not live. A node showing no data here either hasn't reported a full inventory yet, is still running an older agent build from before this feature existed, or — on Home Assistant OS — simply can't report it at all (see below).

### Network metrics (Metrics → Network)

A history chart of inbound/outbound throughput (Mbps), sampled on the same cadence as CPU/mem/disk in the System metrics subtab. Populated automatically once the node is on an agent build new enough to report it — no setup needed.

### Storage & Disk Tools (Utils → Storage / Disk Tools)

**Storage** lists per-volume disk usage (mount point, filesystem, total/free space) rather than just the single root-volume figure shown on Overview — useful on machines with multiple disks or mounts. **Disk Tools** runs on-demand, queued actions against the node, same pending → sent → completed/failed flow as Commands: **Scan** for the largest files on disk, **Clean up temp** (dry-run preview first, then a real pass) to clear old temp-directory files, and **Check Now** for a disk health check (SMART status where the platform supports it). Results from the most recent run of each stay visible on the tab; nothing here runs automatically on a schedule. Not available on Home Assistant OS nodes (see below).

### Speed Test tab (Utils → Speed Test)

Runs a real download/upload/latency test on the node via M-Lab's NDT7 network — no setup or API key required. Click **Run Speedtest Now** to fire one off; it queues like a remote action and moves from pending to completed on the node's next check-in (up to about a minute), then appears at the top of the results table below. If an admin has enabled a speedtest schedule, you'll also see periodic runs show up here on their own with no action from you. Only one test can run on a node at a time — trying to start one while another is already running is rejected rather than queued. Not currently available on Home Assistant OS nodes.

### Unraid support

A node reporting `os_type: unraid` gets an extra **Unraid** main tab:

- **Array** — array/parity status (including live progress if a parity check is running) and a per-disk roster (role, size, temperature, SMART status where reported).
- **Containers** — every Docker container on the box, each with **Start**/**Stop**/**Restart** buttons that queue the same kind of command as any other remote action, with an in-flight indicator while it's pending.
- **VMs** — the same, for libvirt-managed VMs.

Software inventory (System → Software) on Unraid lists Slackware-format packages rather than the deb/rpm-style listing you'll see on Linux/macOS/Windows nodes — this is just Unraid's native package format, not a gap.

### Home Assistant OS support

A Home Assistant instance can run the pktNode agent as a Supervisor Add-on rather than a native install — ask your admin for the install steps if you're setting one up (see the Admin Guide). Because it runs inside the Supervisor sandbox rather than directly on the host, a HAOS node's detail page differs from other platforms in a few ways:

- **Processing and Security tabs report no data** — the Supervisor's API has no process-list or open-ports/firewall equivalent to collect from. This is a platform limitation, not a bug or a stale agent.
- **Disk Tools and Speed Test are not currently available** — hidden/non-functional on these nodes for the same reason (no filesystem access for Disk Tools; Speed Test isn't wired up yet).
- CPU/memory figures are an approximation (Home Assistant Core + Supervisor + every installed add-on's own reported usage, summed), not a true whole-host reading.
- Reboot/shutdown, Docker (add-on) start/stop/restart, Live Terminal, and Check In Now all work normally.

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

If you're a regular user on a managed machine (not an admin operating pktNode), you may see a small pktNode icon in your menu bar or system tray. It shows whether the agent is checking in successfully and the configured server URL, and its **About pktNode Agent** item shows the agent's version and connection details — it has no shortcut into the admin web UI, and it's not something you interact with day-to-day.
