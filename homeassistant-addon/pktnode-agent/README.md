# pktNode Agent (Home Assistant OS Add-on)

Reports this Home Assistant instance to a pktNode server for monitoring
and basic remote control — installed as a Supervisor Add-on, not a native
service, since HAOS doesn't allow installing arbitrary software on the
host itself.

## What this is (and isn't)

This is the exact same `pktnode-agent` binary used for native macOS/
Windows/Linux/Unraid installs — not a separate program. At startup, `run`
checks for `SUPERVISOR_TOKEN` (only ever set when Supervisor launches an
add-on that declared `hassio_api: true`) and, if present, switches to an
entirely different collection/command backend: the local Supervisor REST
API instead of shelling out to the host (see `agent/internal/haosloop`).
That means the data available here is narrower than on other platforms —
no raw process list, no SMART/disk health, no arbitrary Docker control —
everything is scoped to what Supervisor itself exposes:

- Host/OS/Supervisor/Core version info, disk usage
- Installed add-ons, reported as this node's "software"
- Remote actions: reboot, shutdown, and start/stop/restart of other
  add-ons (queued the same way as every other pktNode remote action —
  picked up on the node's next check-in)

## Install (local add-on — no repository needed)

1. Copy this folder to `/addons/local/pktnode-agent/` on the Home
   Assistant host (e.g. via the SSH & Web Terminal add-on, or Samba).
2. In Home Assistant: Settings → Add-ons → Add-on Store → ⋮ → Check for
   updates (or just reload the page) — "pktNode Agent" appears under
   "Local add-ons".
3. Install it, then open its Configuration tab and set:
   - **Server URL** — your pktNode server, e.g. `http://SERVER-IP:8764`
   - **Enrollment Token** — from Settings → Enrollment in the pktNode UI
4. Start the add-on. Check its Log tab for `enrolled — checking in with
   ...` — the node should appear in pktNode within a minute.

## Rebuilding the binary after a code change

```bash
./build.sh
```

Cross-compiles `agent/cmd/pktnode-agent-haos` for linux/amd64 and drops
the binary here, ready for Supervisor to build the image on next install/
rebuild. Currently amd64-only — see `config.yaml`'s `arch` list.
