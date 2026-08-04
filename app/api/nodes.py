"""
app/api/nodes.py — Node (managed endpoint/asset) REST API. Human-facing,
JWT-authenticated — see app/api/agent.py for the agent-facing check-in API
these rows are populated from.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.config import get_settings
from app.database import get_db
from app.dependencies import AdminUser, AnalystUser, CurrentUser, DbDep
from app import totp
from app.auth.local import decode_access_token
from app.terminal_hub import hub

router = APIRouter()


async def _get_setting_int(db: aiosqlite.Connection, key: str, default: int) -> int:
    async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
        row = await cur.fetchone()
    if not row:
        return default
    try:
        return int(json.loads(row[0]))
    except (ValueError, TypeError):
        return default


_STATUS_EXPR = """
    CASE
        WHEN n.is_active = 0 THEN 'decommissioned'
        WHEN n.last_checkin_at IS NULL THEN 'pending'
        WHEN n.last_checkin_at < datetime('now', ? || ' seconds') THEN 'stale'
        WHEN n.last_checkin_at < datetime('now', ? || ' seconds') THEN 'offline'
        ELSE 'online'
    END AS status
"""


async def _status_params(db: aiosqlite.Connection) -> list[str]:
    offline_after = await _get_setting_int(db, "offline_after_sec", 300)
    stale_after = await _get_setting_int(db, "stale_after_sec", 86400)
    return [f"-{stale_after}", f"-{offline_after}"]


@router.get("/")
async def list_nodes(
    _: CurrentUser,
    db: DbDep,
    status: Optional[str] = Query(None, description="Filter by computed status"),
    q: Optional[str] = Query(None, description="Search hostname/display_name"),
) -> list[dict]:
    db.row_factory = aiosqlite.Row
    params = await _status_params(db)
    clauses = []
    if q:
        clauses.append("(n.hostname LIKE ? OR n.display_name LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = f"""
        SELECT n.id, n.agent_uuid, n.hostname, n.display_name, n.os_type, n.os_version,
               n.arch, n.agent_version, n.ip_address, n.manufacturer, n.model,
               n.cpu_model, n.cpu_cores, n.memory_total_mb, n.disk_total_gb, n.disk_free_gb,
               n.uptime_seconds, n.current_user, n.tags_json, n.is_active, n.alert_host_down_override,
               n.first_seen_at, n.last_checkin_at, n.updated_at,
               {_STATUS_EXPR}
        FROM nodes n
        {where}
        ORDER BY n.hostname
    """
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()

    result = []
    for r in rows:
        d = dict(r)
        try:
            d["tags"] = json.loads(d.pop("tags_json"))
        except Exception:
            d["tags"] = []
        d["alert_host_down_override"] = (
            None if d["alert_host_down_override"] is None else bool(d["alert_host_down_override"])
        )
        result.append(d)

    if status:
        result = [d for d in result if d["status"] == status]
    else:
        # Decommissioned nodes have their own dedicated page — keep them
        # out of the default/unfiltered list so they don't clutter the
        # live-asset view. Pass ?status=decommissioned explicitly to see them.
        result = [d for d in result if d["status"] != "decommissioned"]
    return result


@router.get("/{node_id}")
async def get_node(node_id: int, _: CurrentUser, db: DbDep) -> dict:
    db.row_factory = aiosqlite.Row
    params = await _status_params(db)
    async with db.execute(
        f"SELECT n.*, {_STATUS_EXPR} FROM nodes n WHERE n.id = ?",
        (*params, node_id),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found")
    node = dict(row)
    node["has_tray"] = bool(node["has_tray"])
    try:
        node["tags"] = json.loads(node.pop("tags_json"))
    except Exception:
        node["tags"] = []
    node["alert_host_down_override"] = (
        None if node["alert_host_down_override"] is None else bool(node["alert_host_down_override"])
    )

    async with db.execute(
        "SELECT name, version, publisher, install_date, last_seen_at FROM node_software WHERE node_id=? ORDER BY name",
        (node_id,),
    ) as cur:
        node["software"] = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT pid, name, cpu_pct, mem_mb, username, captured_at FROM node_processes WHERE node_id=? ORDER BY mem_mb DESC",
        (node_id,),
    ) as cur:
        node["processes"] = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT name, mac_address, ip_addresses, is_up FROM node_interfaces WHERE node_id=?",
        (node_id,),
    ) as cur:
        interfaces = []
        for r in await cur.fetchall():
            i = dict(r)
            try:
                i["ip_addresses"] = json.loads(i["ip_addresses"])
            except Exception:
                i["ip_addresses"] = []
            interfaces.append(i)
        node["interfaces"] = interfaces

    async with db.execute(
        "SELECT protocol, port, process_name, pid, captured_at FROM node_ports WHERE node_id=? ORDER BY protocol, port",
        (node_id,),
    ) as cur:
        node["ports"] = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT cpu_pct, mem_pct, disk_pct, recorded_at FROM node_metrics_history "
        "WHERE node_id=? ORDER BY recorded_at DESC LIMIT 500",
        (node_id,),
    ) as cur:
        node["metrics_history"] = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT sent_mbps, recv_mbps, recorded_at FROM node_network_history "
        "WHERE node_id=? ORDER BY recorded_at DESC LIMIT 500",
        (node_id,),
    ) as cur:
        node["network_history"] = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT mount_point, device, fs_type, total_gb, free_gb, used_pct FROM node_disks "
        "WHERE node_id=? ORDER BY mount_point",
        (node_id,),
    ) as cur:
        node["disks"] = [dict(r) for r in await cur.fetchall()]

    if node["os_type"] == "unraid":
        async with db.execute(
            "SELECT state, parity_check_active, parity_check_pct, parity_check_errors, last_sync_at, last_sync_errors "
            "FROM node_unraid_array WHERE node_id=?",
            (node_id,),
        ) as cur:
            row = await cur.fetchone()
        unraid_array = dict(row) if row else None
        if unraid_array is not None:
            unraid_array["parity_check_active"] = bool(unraid_array["parity_check_active"])
        node["unraid_array"] = unraid_array

        async with db.execute(
            "SELECT name, role, device, status, temp_c, size_gb, fs_type, num_errors FROM node_unraid_disks "
            "WHERE node_id=? ORDER BY id",
            (node_id,),
        ) as cur:
            node["unraid_disks"] = [dict(r) for r in await cur.fetchall()]

        async with db.execute(
            "SELECT name, image, state, status FROM node_unraid_containers WHERE node_id=? ORDER BY name",
            (node_id,),
        ) as cur:
            node["unraid_containers"] = [dict(r) for r in await cur.fetchall()]

        async with db.execute(
            "SELECT name, state FROM node_unraid_vms WHERE node_id=? ORDER BY name",
            (node_id,),
        ) as cur:
            node["unraid_vms"] = [dict(r) for r in await cur.fetchall()]
    else:
        node["unraid_array"] = None
        node["unraid_disks"] = []
        node["unraid_containers"] = []
        node["unraid_vms"] = []

    return node


class NodeUpdate(BaseModel):
    display_name: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[list[str]] = None


@router.patch("/{node_id}")
async def update_node(node_id: int, body: NodeUpdate, _: AnalystUser, db: DbDep) -> dict:
    async with db.execute("SELECT id FROM nodes WHERE id=?", (node_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found")

    updates: dict[str, Any] = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name
    if body.notes is not None:
        updates["notes"] = body.notes
    if body.tags is not None:
        if body.tags:
            placeholders = ",".join("?" for _ in body.tags)
            async with db.execute(
                f"SELECT name FROM groups WHERE name IN ({placeholders})", body.tags
            ) as cur:
                known = {r["name"] for r in await cur.fetchall()}
            unknown = [t for t in body.tags if t not in known]
            if unknown:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unknown group(s): {', '.join(unknown)} — create them in Settings → Groups first",
                )
        updates["tags_json"] = json.dumps(body.tags)

    if updates:
        set_clause = ", ".join(f"{k}=?" for k in updates) + ", updated_at=datetime('now')"
        await db.execute(
            f"UPDATE nodes SET {set_clause} WHERE id=?", (*updates.values(), node_id)
        )
        await db.commit()
    return {"ok": True}


class AlertOverrideUpdate(BaseModel):
    # None = inherit the global alert_host_down_enabled setting; True/False =
    # force this node's node_offline alert on/off regardless of the global setting.
    host_down_enabled: Optional[bool] = None


@router.patch("/{node_id}/alert-overrides")
async def update_alert_overrides(node_id: int, body: AlertOverrideUpdate, _: AnalystUser, db: DbDep) -> dict:
    async with db.execute("SELECT id FROM nodes WHERE id=?", (node_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found")

    value = None if body.host_down_enabled is None else int(body.host_down_enabled)
    await db.execute(
        "UPDATE nodes SET alert_host_down_override=?, updated_at=datetime('now') WHERE id=?",
        (value, node_id),
    )
    await db.commit()
    return {"ok": True}


@router.post("/{node_id}/decommission")
async def decommission_node(node_id: int, _: AdminUser, db: DbDep) -> dict:
    """
    Fully decommission and revoke a node — for a machine that's gone or had
    its agent removed, not just temporarily offline:

      - marks it inactive (stops appearing as a live asset)
      - revokes its agent_tokens (any surviving copy of the agent can no
        longer check in)
      - clears its override_secret (the offline tamper-lockout code stops
        working too — a leftover local install can't unlock/uninstall
        itself with the old code anymore)
      - purges current-state inventory snapshots (installed software,
        running processes, network interfaces) — those describe "what's
        on the machine right now" and are meaningless once it's gone

    Deliberately keeps: metrics history, command history, and alert
    history — those are an audit trail, not current state, and this
    action is reversible in the sense that the node row itself (and that
    history) survives; only DELETE removes the row entirely.
    """
    async with db.execute("SELECT id FROM nodes WHERE id=?", (node_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found")
    await db.execute(
        "UPDATE nodes SET is_active=0, status='decommissioned', override_secret=NULL, updated_at=datetime('now') WHERE id=?",
        (node_id,),
    )
    await db.execute("UPDATE agent_tokens SET revoked=1 WHERE node_id=?", (node_id,))
    await db.execute("DELETE FROM node_software WHERE node_id=?", (node_id,))
    await db.execute("DELETE FROM node_processes WHERE node_id=?", (node_id,))
    await db.execute("DELETE FROM node_interfaces WHERE node_id=?", (node_id,))
    await db.commit()
    return {"ok": True}


@router.get("/{node_id}/override-code")
async def get_override_code(node_id: int, _: AdminUser, db: DbDep) -> dict:
    """
    The live tamper-lockout override code for this node — admin-only.
    The agent verifies this fully offline (derives the same code from a
    secret it was given once at enrollment plus its own clock), so there
    is no "issue a code" API call here, just a read of what's currently
    valid. Give this code to whoever needs to stop/uninstall the agent
    locally on the machine.
    """
    async with db.execute("SELECT override_secret FROM nodes WHERE id=?", (node_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found")
    if not row[0]:
        raise HTTPException(status_code=409, detail="This node has no override secret (enrolled before tamper-lockout support was added — re-enroll to get one)")
    return {"code": totp.current_code(row[0]), "expires_in_sec": totp.seconds_remaining()}


@router.delete("/{node_id}", status_code=204)
async def delete_node(node_id: int, _: AdminUser, db: DbDep) -> None:
    async with db.execute("SELECT id FROM nodes WHERE id=?", (node_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found")

    # The alert engine's auto-resolve logic joins alert_events against a
    # still-existing node row (is_active=0 is what it checks for a
    # decommissioned node) — once the row is gone entirely there's nothing
    # left to join against, so any still-open alert for this node would
    # otherwise sit unresolved forever. Resolve them here rather than
    # deleting the rows outright, matching decommission's "keeps alert
    # history for the record" — this just closes them out, doesn't erase them.
    await db.execute(
        "UPDATE alert_events SET resolved_at=datetime('now'), auto_resolved=1 WHERE node_id=? AND resolved_at IS NULL",
        (node_id,),
    )
    await db.execute("DELETE FROM nodes WHERE id=?", (node_id,))
    await db.commit()


# ── Remote actions ───────────────────────────────────────────────────────────

class CommandIn(BaseModel):
    command_type: str   # restart_service | kill_process | run_script | reboot | shutdown | update_agent | ...
    payload: dict = {}


_VALID_COMMAND_TYPES = {
    "restart_service", "kill_process", "run_script", "reboot", "shutdown",
    "run_speedtest", "update_agent",
    "disk_largest_files", "disk_cleanup_temp", "disk_health_check",
    "docker_start", "docker_stop", "docker_restart",
    "vm_start", "vm_stop", "vm_restart",
}

# Container/VM actions read as "instant" in Unraid's own UI, so waiting out
# the rest of a check-in interval (up to a minute-plus) to even *start*
# feels broken by comparison — these get an automatic "check in now" nudge
# over the live control channel right after queuing (best-effort, same
# push /checkin-now already sends; silently falls back to the normal
# check-in cadence if the node has no live connection right now).
_LIVE_NUDGE_COMMAND_TYPES = {
    "docker_start", "docker_stop", "docker_restart",
    "vm_start", "vm_stop", "vm_restart",
}


@router.get("/{node_id}/commands")
async def list_commands(node_id: int, _: CurrentUser, db: DbDep) -> list[dict]:
    db.row_factory = aiosqlite.Row
    async with db.execute(
        """
        SELECT c.id, c.command_type, c.payload_json, c.status, c.created_at,
               c.sent_at, c.completed_at, c.exit_code, c.result_json,
               u.username AS created_by
        FROM commands c
        LEFT JOIN users u ON u.id = c.created_by
        WHERE c.node_id = ?
        ORDER BY c.created_at DESC
        LIMIT 200
        """,
        (node_id,),
    ) as cur:
        rows = await cur.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.pop("payload_json") or "{}")
        except Exception:
            d["payload"] = {}
        try:
            d["result"] = json.loads(d.pop("result_json")) if d.get("result_json") else None
        except Exception:
            d["result"] = None
        result.append(d)
    return result


@router.post("/{node_id}/commands", status_code=201)
async def queue_command(node_id: int, body: CommandIn, user: AnalystUser, db: DbDep) -> dict:
    if body.command_type not in _VALID_COMMAND_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown command_type: {body.command_type}")
    async with db.execute("SELECT id FROM nodes WHERE id=? AND is_active=1", (node_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found or decommissioned")

    async with db.execute(
        "INSERT INTO commands (node_id, command_type, payload_json, created_by) VALUES (?,?,?,?)",
        (node_id, body.command_type, json.dumps(body.payload), user["id"]),
    ) as cur:
        command_id = cur.lastrowid
    await db.commit()

    if body.command_type in _LIVE_NUDGE_COMMAND_TYPES:
        agent = hub.get_agent(node_id)
        if agent is not None:
            try:
                await agent.send({"type": "checkin_now"})
            except Exception:
                pass  # best-effort — falls back to the normal check-in cadence

    return {"id": command_id, "status": "pending"}


# ── Agent updates ────────────────────────────────────────────────────────
# Binaries live in {install_dir}/agent-releases (see app/main.py's static
# mount, which is what enrolled agents actually download from) — agent/
# build.sh drops a VERSION file alongside them on every rebuild, extracted
# straight from the Go AgentVersion const, so it can never drift from
# what's actually in the directory.

def _agent_releases_dir() -> Path:
    return Path(get_settings().install_dir) / "agent-releases"


@router.get("/agents/latest-version")
async def latest_agent_version(_: CurrentUser) -> dict:
    version_file = _agent_releases_dir() / "VERSION"
    if not version_file.exists():
        return {"version": None}
    return {"version": version_file.read_text().strip()}


class AgentUpdateIn(BaseModel):
    node_ids: Optional[list[int]] = None   # explicit selection
    all: bool = False                      # every active node instead of node_ids
    outdated_only: bool = False            # skip nodes already reporting the latest version


@router.post("/agents/update", status_code=201)
async def push_agent_update(body: AgentUpdateIn, user: AnalystUser, db: DbDep) -> dict:
    """
    Queue an update_agent command for the selected (or all) active nodes.
    Each one downloads the current agent-releases build for its own OS/arch
    and installs it on its next check-in (see execUpdateAgent in the agent's
    internal/commands package, and app/api/agent.py for the check-in side).
    """
    if not body.all and not body.node_ids:
        raise HTTPException(status_code=400, detail="Provide node_ids or set all=true")

    db.row_factory = aiosqlite.Row
    if body.all:
        async with db.execute("SELECT id, agent_version FROM nodes WHERE is_active=1") as cur:
            targets = await cur.fetchall()
    else:
        placeholders = ",".join("?" for _ in body.node_ids)
        async with db.execute(
            f"SELECT id, agent_version FROM nodes WHERE is_active=1 AND id IN ({placeholders})",
            body.node_ids,
        ) as cur:
            targets = await cur.fetchall()

    if body.outdated_only:
        version_file = _agent_releases_dir() / "VERSION"
        latest = version_file.read_text().strip() if version_file.exists() else None
        if latest:
            targets = [t for t in targets if t["agent_version"] != latest]

    queued = []
    for t in targets:
        async with db.execute(
            "INSERT INTO commands (node_id, command_type, payload_json, created_by) VALUES (?,?,?,?)",
            (t["id"], "update_agent", "{}", user["id"]),
        ) as cur:
            queued.append({"node_id": t["id"], "command_id": cur.lastrowid})
    await db.commit()
    return {"queued": queued, "count": len(queued)}


@router.get("/{node_id}/speedtest-results")
async def list_speedtest_results(node_id: int, _: CurrentUser, db: DbDep) -> list[dict]:
    db.row_factory = aiosqlite.Row
    async with db.execute(
        """
        SELECT id, status, download_mbps, upload_mbps, latency_ms, jitter_ms,
               server_fqdn, error, triggered_by, created_at
        FROM speedtest_results
        WHERE node_id = ?
        ORDER BY created_at DESC
        LIMIT 200
        """,
        (node_id,),
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ── Force an immediate check-in ─────────────────────────────────────────────
# Piggybacks on the same always-open control channel Live Terminal uses
# (see app/terminal_hub.py) rather than opening anything new — the agent
# treats a "checkin_now" push on that channel as a signal to skip the rest
# of its current poll interval and check in right away, instead of waiting
# it out. Same reachability requirement as Live Terminal: the node needs a
# live control-channel connection (agent online and new enough to have one).

@router.post("/{node_id}/checkin-now")
async def checkin_now(node_id: int, _: AnalystUser, db: DbDep) -> dict:
    async with db.execute("SELECT id FROM nodes WHERE id=? AND is_active=1", (node_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Node not found or decommissioned")
    agent = hub.get_agent(node_id)
    if agent is None:
        raise HTTPException(
            status_code=409,
            detail="This node has no live control-channel connection right now (agent offline, or too old to support it).",
        )
    await agent.send({"type": "checkin_now"})
    return {"ok": True}


# ── Live terminal ─────────────────────────────────────────────────────────
#
# The browser can't set a custom Authorization header on a WebSocket
# handshake, so the JWT travels as a query param instead — see
# app/terminal_hub.py for the rest of the wire protocol.

@router.websocket("/{node_id}/terminal/ws")
async def node_terminal_ws(websocket: WebSocket, node_id: int, db: DbDep, token: str = Query(...)) -> None:
    payload = decode_access_token(token)
    if not payload or payload.get("role") not in ("admin", "analyst"):
        await websocket.close(code=4401)
        return
    async with db.execute("SELECT username FROM users WHERE id=? AND is_active=1", (payload["sub"],)) as cur:
        user_row = await cur.fetchone()
    if not user_row:
        await websocket.close(code=4401)
        return
    async with db.execute("SELECT id FROM nodes WHERE id=? AND is_active=1", (node_id,)) as cur:
        node_row = await cur.fetchone()
    if not node_row:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    agent, _browser, error = await hub.start_session(node_id, websocket, user_row["username"], cols=80, rows=24)
    if error:
        await websocket.send_text(json.dumps({"type": "status", "state": "error", "message": error}))
        await websocket.close(code=4409)
        return

    await websocket.send_text(json.dumps({"type": "status", "state": "connecting"}))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            await hub.handle_browser_message(agent, msg)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.stop_session(agent)
