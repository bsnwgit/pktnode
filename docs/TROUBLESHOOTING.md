# pktNode — Troubleshooting

Symptom, cause, and the command that proves which cause it is.

`<INSTALL_DIR>` is the server's install directory (`/opt/pktnode` by default).
"Node" means a managed endpoint running the agent.

---

## Contents

- [The first five minutes](#the-first-five-minutes)
- [The server will not start](#the-server-will-not-start)
- [The server runs but nothing answers](#the-server-runs-but-nothing-answers)
- [The UI is blank, stale, or 404](#the-ui-is-blank-stale-or-404)
- [Login and accounts](#login-and-accounts)
- [A node will not enrol](#a-node-will-not-enrol)
- [A node enrols but goes offline](#a-node-enrols-but-goes-offline)
- [Live Terminal and File Transfer](#live-terminal-and-file-transfer)
- [Updating agents](#updating-agents)
- [Platform-specific agent problems](#platform-specific-agent-problems)
- [Inventory is missing or stale](#inventory-is-missing-or-stale)
- [Alerts and notifications](#alerts-and-notifications)
- [A config change did not take effect](#a-config-change-did-not-take-effect)
- [TLS / HTTPS](#tls--https)
- [Backup, upgrades and uninstall](#backup-upgrades-and-uninstall)
- [What to capture before reporting a problem](#what-to-capture-before-reporting-a-problem)

---

## The first five minutes

```bash
sudo systemctl status pktnode --no-pager
```

```bash
sudo journalctl -u pktnode -n 100 --no-pager
```

```bash
sudo tail -n 100 <INSTALL_DIR>/logs/pktnode.log
```

```bash
sudo ss -ltnp | grep 8764
```

```bash
curl -s http://127.0.0.1:8764/api/health
```

| What you see | Go to |
|---|---|
| `inactive (dead)` or `failed` | [The server will not start](#the-server-will-not-start) |
| Running, nothing on 8764 | [The server runs but nothing answers](#the-server-runs-but-nothing-answers) |
| Health 200, UI blank or 404 | [The UI is blank, stale, or 404](#the-ui-is-blank-stale-or-404) |
| Health 200, no nodes | [A node will not enrol](#a-node-will-not-enrol) |
| Nodes listed but offline | [A node enrols but goes offline](#a-node-enrols-but-goes-offline) |

**One thing to know before diagnosing any node problem: the node never accepts
an inbound connection.** The agent always dials out — check-ins over HTTP, and a
persistent outbound WebSocket for the control channel. No firewall change is
ever needed on the node's end. If a node cannot reach the server, the problem is
outbound from the node, or inbound at the server.

---

## The server will not start

```bash
sudo journalctl -u pktnode -n 200 --no-pager
sudo tail -n 200 <INSTALL_DIR>/logs/pktnode.log
```

Reproduce in the foreground:

```bash
sudo -u <service-user> \
  PKTNODE_CONFIG=<INSTALL_DIR>/config.yaml \
  PKTNODE_INSTALL_DIR=<INSTALL_DIR> \
  <INSTALL_DIR>/venv/bin/python -m app.server
```

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError` | venv missing packages, or built against a different Python | `<INSTALL_DIR>/venv/bin/pip install -r requirements.txt` |
| `yaml.scanner.ScannerError` | `config.yaml` is not valid YAML | `python3 -c "import yaml; yaml.safe_load(open('<INSTALL_DIR>/config.yaml'))"` |
| Complaint about `secret_key` / `credential_key` | Left at `CHANGE_ME_…` | `openssl rand -hex 32`; and `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `Address already in use` | Something else holds 8764 | `sudo ss -ltnp \| grep 8764` |
| `Permission denied` binding a low port | The pktNode unit does **not** set `CAP_NET_BIND_SERVICE` | Keep the default high port |
| Fernet `InvalidToken` | `credential_key` changed after secrets were stored | See [A config change did not take effect](#a-config-change-did-not-take-effect) |
| `Permission denied` on DB, logs or `agent-releases/` | Install dir not owned by the service user | `sudo chown -R <service-user>:<service-group> <INSTALL_DIR>` |

`Restart=on-failure`, burst limit 3 in 60s — after that it stays `failed`.

---

## The server runs but nothing answers

```bash
sudo ss -ltnp | grep 8764
curl -sv http://127.0.0.1:8764/api/health
```

`host:` and `port:` come from `config.yaml` at every process start — a port
change needs a restart, never a unit edit.

**A port change breaks every enrolled agent** until they are pointed at the new
address: the agent dials the server URL it was installed with.

---

## The UI is blank, stale, or 404

| Symptom | Cause | Fix |
|---|---|---|
| `{"detail":"Not Found"}` at the root | The frontend was never built | `cd frontend && npm install && npm run build`, then restart. Node.js 20.x LTS is a prerequisite `install.sh` does not install |
| Blank page, console 404s on `/assets/*` | `dist` stale or half-built | Rebuild, then hard-refresh |
| Old UI after an upgrade | Cached `index.html` pinning old bundles | Hard refresh (Ctrl/Cmd-Shift-R) |
| Every API call 401 | Session expired | See [Login and accounts](#login-and-accounts) |

---

## Login and accounts

bcrypt plus JWT, with TOTP available. Roles `admin` / `analyst` / `viewer`.

| Symptom | Cause | Fix |
|---|---|---|
| 401 immediately after logging in | Clock skew invalidates the token's `exp` | `timedatectl`; fix NTP |
| **TOTP codes always rejected** | Clock skew — TOTP is time-based and unforgiving | Fix NTP on the server *and* on the device generating codes |
| Cannot manage enrolment tokens | Token management is admin-only | Needs `admin` |
| Locked out of every account | No admin session left | Reset the hash against SQLite using the app's own venv for bcrypt |

```bash
<INSTALL_DIR>/venv/bin/python -c "import bcrypt; print(bcrypt.hashpw(b'NewPassword1!', bcrypt.gensalt()).decode())"
```

---

## A node will not enrol

### How enrolment actually works

An **enrolment token** is a shared secret baked into the agent installer at
install time. On first contact the agent exchanges it via `POST /api/agent/enroll`
for its own per-node **agent token**, and never uses the enrolment token again.

Two consequences that explain most enrolment problems:

- **The raw enrolment token is shown exactly once**, when it is created. Only a
  SHA-256 hash is stored. If it was not copied, issue a new one — it cannot be
  recovered.
- **An installer carries the token it was built with.** Rotating tokens does not
  update installers already distributed.

### Diagnosis

| Symptom | Cause | Fix |
|---|---|---|
| Node never appears at all | The install command never ran, or never reached the server | Run it manually on the node and read the output |
| Enrolment rejected | Token expired | Tokens can carry `expires_in_days`. Check the token list |
| Enrolment rejected | Token hit its use limit | Tokens can carry `max_uses`, and the list shows how many nodes enrolled against each |
| Enrolment rejected | Token revoked or never existed | Issue a new one |
| Connection refused / timeout from the node | The node cannot reach the server URL | Test from the node itself: `curl -v http://<server>:8764/api/health` |
| TLS error during enrolment | Self-signed server certificate the agent will not accept | See [TLS / HTTPS](#tls--https) |
| Enrols, then immediately disappears | Two nodes sharing an identity — a cloned VM or golden image with the agent already installed | Reinstall the agent on the clone so it enrols fresh |

The last row is worth watching for: imaging a machine that already has an
enrolled agent gives two machines the same agent token.

---

## A node enrols but goes offline

Status is driven by how long it has been since the last check-in:

| Setting | Default | Meaning |
|---|---|---|
| `offline_after_sec` | 300 | No check-in for this long → offline |
| `stale_after_sec` | 86400 | No check-in for this long → stale |

Both are in `config.yaml` and need a restart.

| Symptom | Cause |
|---|---|
| Flaps online/offline | Network path, or a laptop sleeping. Check whether the pattern matches working hours |
| All nodes went offline at once | The server, not the nodes. Check the server was up, and that its address or port did not change |
| One node offline, reachable by ping | The agent service is not running on it — check the agent's own service status on that machine |
| Offline right after a server upgrade | The server was down longer than `offline_after_sec`; they should return on their next check-in |
| Permanently stale | The machine is gone, or the agent was removed without deleting the node record |

---

## Live Terminal and File Transfer

Both run over **one** persistent outbound WebSocket — the control channel — that
the agent keeps open in addition to its HTTP check-ins. Terminal and file
sessions are multiplexed over that same connection in independent slots, so both
can be open on a node at once.

Each kind is capped at **one active session per node**: opening a second
terminal preempts the first, and likewise for file sessions.

| Symptom | Cause | Fix |
|---|---|---|
| "No connection" on Live Terminal | The agent is offline, or predates the feature | Check the node's status first, then its agent version |
| File Transfer stuck on "Connecting…" | Agent predates 0.9.0 | Update the agent. **If Live Terminal works on the same node, the control channel is fine** — it is purely the agent version |
| A session dies when someone else opens one | One session per kind per node, by design | Expected — the second preempts the first |
| Both features fail on every node, HTTP check-ins fine | The control-channel WebSocket is being blocked, or the server is running more than one worker | See below |
| Sessions drop after a fixed interval | An idle timeout in a proxy between agent and server | Configure the proxy for long-lived WebSockets |

**The relay registry is single-process and in memory.** That is correct for
pktNode's one-uvicorn-worker deployment, and it breaks under multiple workers —
an admin's browser can land on a different process than the one holding the
agent's control channel. If terminal and file transfer fail while check-ins
succeed, confirm the unit runs a single worker before anything else.

---

## Updating agents

| Agent version | How it updates |
|---|---|
| 0.2.0 and newer | Push from the Nodes page |
| Older than 0.2.0 | One manual reinstall to reach a build that understands the push mechanism at all |

Rebuild release binaries with `agent/build.sh`, which also refreshes
`agent-releases/VERSION`.

| Symptom | Cause |
|---|---|
| Push update does nothing | Agent is older than 0.2.0 |
| Push fails to download | The node cannot reach the server's release endpoint, or `agent-releases/` is missing the asset |
| Checksum mismatch | The release asset was replaced without rebuilding — rerun `agent/build.sh` |
| Agent updates then goes offline | The new binary failed to start on that platform. Check the agent's own service log on the node |

---

## Platform-specific agent problems

| Platform | Symptom | Cause |
|---|---|---|
| macOS | File Transfer: "read-only file system" | Expected. That path is on the sealed System volume — `/`, `/System`, `/bin`, `/sbin`, `/usr`. No privilege level writes there outside Recovery Mode. Navigate to the home directory or another writable location |
| macOS | Agent will not start after install | Gatekeeper or TCC. Check the agent's log and System Settings → Privacy & Security |
| Windows | Agent not surviving reboot | The service was not registered — reinstall |
| Home Assistant OS | Add-on install fails: "Dockerfile is missing" | The Add-on Store listing is stale. **Settings → System → Restart → Restart Home Assistant**, then reinstall |
| Unraid | Agent does not survive a reboot | `/boot/config/go` is missing the pktNode block. Reinstalling repairs it |
| Linux | Agent runs but reports thin inventory | Some inventory needs privileges the agent was not given |

---

## Inventory is missing or stale

| Symptom | Cause |
|---|---|
| Inventory older than the check-in interval | Inventory is gathered on check-in — a node that has not checked in has not refreshed |
| Software list empty | The agent could not enumerate packages on that platform, or lacks the privileges to |
| Resource usage missing | Same — check the agent's own log on the node |
| Speedtest results absent | Speedtests are triggered, not continuous. Check whether one was actually run |
| A node's data froze at a point in time | It stopped checking in then. Its status should also be offline or stale |

---

## Alerts and notifications

Channels are in-app, Email (SMTP), Slack, PagerDuty, generic Webhook and
Tracecat. Senders are written never to raise, so **a failing channel looks like
nothing happening**. Use Send Test for the real error.

| Symptom | Cause |
|---|---|
| Node-offline alerts never fire | The rule is not enabled, or `offline_after_sec` is longer than you think |
| Alert storm after a server outage | Every node crossed the offline threshold at once. Expected |
| Email never arrives | SMTP host, port (default 587), TLS, credentials, or the relay refusing the sender |
| Webhook target sees nothing | Method, headers, or the Jinja2 payload template failing to render |

---

## A config change did not take effect

**Wrong file.** Env vars beat `config.yaml` silently:

```bash
systemctl show pktnode -p Environment
```

**Not restarted.** Nothing in `config.yaml` is re-read live — including
`offline_after_sec` and `stale_after_sec` — and restoring a backed-up
`config.yaml` never restarts the service.

**The setting is not in `config.yaml`.** That file holds startup and
infrastructure only. Alert thresholds, notification channels and enrolment
tokens all live in **SQLite** and are managed in the UI.

### `credential_key` changed or was lost

Stored secrets are Fernet-encrypted with it. Change it and they become
undecryptable. Restore the old key or re-enter them. Note this does **not**
invalidate agent tokens, which are hashed rather than encrypted — agents keep
working.

---

## TLS / HTTPS

`ssl_dir` defaults to `<INSTALL_DIR>/ssl`.

| Symptom | Cause | Fix |
|---|---|---|
| Still HTTP after uploading a cert | Not restarted | Restart |
| Will not start after upload | Key does not match the cert | Compare `openssl x509 -noout -modulus -in cert.pem \| openssl md5` with `openssl rsa -noout -modulus -in key.pem \| openssl md5` |
| **Every agent goes offline after enabling HTTPS** | The agents were installed against the `http://` URL and are still dialling it | They must be pointed at the new scheme — a reinstall or a config update on each node |
| Agents reject a self-signed certificate | Expected | Use a certificate the nodes' trust stores accept, or add the CA to them |

```bash
curl -k https://127.0.0.1:8764/api/health
```

Switching scheme or port is the single most disruptive change on this app,
because every agent holds the URL it was installed with. Plan it.

---

## Backup, upgrades and uninstall

Backups write timestamped `backup_*` directories; the settings live in SQLite.
A restored `config.yaml` never restarts the service. **Never copy a live SQLite
database with `cp`** — take `pktnode.db`, `-wal` and `-shm` with the service
stopped.

Upgrade the server:

```bash
git pull
cd frontend && npm install && npm run build && cd ..
sudo systemctl restart pktnode
```

If the agent changed, rebuild binaries with `agent/build.sh` as well.

Re-running `install.sh` is better when a release drops or renames a file; data
is kept, and `PKTNODE_REMOVE_EXISTING=1` (or `0`) answers its prompt from a
script.

Uninstall:

```bash
bash <INSTALL_DIR>/uninstall.sh
```

Data is kept by default — `config.yaml`, `pktnode.db` and its `-wal`/`-shm`,
`logs/`, `backups/`, `ssl/` and **`agent-releases/`**. `--purge` deletes them and
is not recoverable; `--dry-run` prints what would go; `--yes` skips prompts;
`--dir PATH` if the unit is already gone.

Uninstalling the server does **not** uninstall the agents. They will simply fail
to check in.

**Never mirror over an install directory with `rsync --delete`** — that destroys
the database, the enrolment tokens and `agent-releases/` together.

---

## What to capture before reporting a problem

1. `VERSION` on the server, and the **agent version** on the affected node —
   several behaviours are version-gated (0.2.0 for push updates, 0.9.0 for File
   Transfer).
2. `systemctl status pktnode` plus the last 200 lines of **both** the journal and
   `logs/pktnode.log`.
3. `config.yaml` **with `secret_key`, `credential_key` and passwords removed**.
4. From the affected node: `curl -v http://<server>:8764/api/health`. That splits
   "the agent is broken" from "the node cannot reach the server".
5. The agent's own service status and log on the node.
6. For terminal or file transfer: whether HTTP check-ins are still working, and
   whether the server runs a single worker.
7. The node's last check-in time, against `offline_after_sec`.

Never paste real enrolment tokens, agent tokens, or an unredacted `config.yaml`.
