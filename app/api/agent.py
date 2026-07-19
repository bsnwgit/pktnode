"""
app/api/agent.py — Agent-facing endpoints.

Everything under this router is called by the pktNode agent binary, not the
browser UI, and authenticates differently: POST /enroll takes a one-time
enrollment token (see app/api/enrollment.py); every other endpoint here takes
the per-node agent bearer token issued by /enroll (see CurrentNode in
app/dependencies.py). Never mix these up with the human-facing JWT auth used
by the rest of the API.
"""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import CurrentNode, DbDep, hash_agent_token
from app import totp

log = logging.getLogger("pktnode.agent")
router = APIRouter()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def _get_setting_int(db: aiosqlite.Connection, key: str, default: int) -> int:
    async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
        row = await cur.fetchone()
    if not row:
        return default
    try:
        return int(json.loads(row[0]))
    except (ValueError, TypeError):
        return default


# ── Enrollment ──────────────────────────────────────────────────────────────

class EnrollRequest(BaseModel):
    enrollment_token: str
    agent_uuid: str
    hostname: str
    os_type: str            # darwin | windows | linux
    os_version: str = ""
    arch: str = ""
    agent_version: str = ""
    serial_number: str = ""


@router.post("/enroll", status_code=201)
async def enroll(body: EnrollRequest, db: DbDep) -> dict:
    token_hash = _hash_token(body.enrollment_token)
    async with db.execute(
        "SELECT id, expires_at, max_uses, use_count, revoked FROM enrollment_tokens WHERE token_hash=?",
        (token_hash,),
    ) as cur:
        token_row = await cur.fetchone()
    if not token_row:
        raise HTTPException(status_code=401, detail="Invalid enrollment token")

    token_id, expires_at, max_uses, use_count, revoked = token_row
    if revoked:
        raise HTTPException(status_code=401, detail="Enrollment token has been revoked")
    if expires_at:
        async with db.execute("SELECT datetime('now') > datetime(?)", (expires_at,)) as cur:
            expired = (await cur.fetchone())[0]
        if expired:
            raise HTTPException(status_code=401, detail="Enrollment token has expired")
    if max_uses is not None and use_count >= max_uses:
        raise HTTPException(status_code=401, detail="Enrollment token has reached its use limit")

    # Upsert the node by agent_uuid — reinstalling the agent on top of an
    # existing install (its local config/agent_uuid survived) re-enrolls
    # it rather than creating a duplicate row.
    async with db.execute("SELECT id FROM nodes WHERE agent_uuid=?", (body.agent_uuid,)) as cur:
        existing = await cur.fetchone()

    # A full wipe/reinstall generates a brand-new agent_uuid (it's only
    # ever persisted in the agent's local config), so the lookup above
    # misses it even though it's the same physical machine. Fall back to
    # matching a *decommissioned* node by hardware serial number — a real,
    # stable hardware identity that survives a wipe — so it's revived in
    # place instead of creating a second row for the same asset. Only
    # decommissioned nodes are eligible (never hijack a still-active row
    # off a serial coincidence/bug), and only when the agent actually
    # reported a non-empty serial (some VMs/permission setups can't read one).
    revived = False
    if not existing and body.serial_number:
        async with db.execute(
            "SELECT id FROM nodes WHERE is_active=0 AND serial_number=? AND serial_number != '' LIMIT 1",
            (body.serial_number,),
        ) as cur:
            existing = await cur.fetchone()
        revived = existing is not None

    # Fresh override secret on every (re-)enroll, same reasoning as the
    # agent token below — an admin never needs to remember the code, only
    # look it up live, so rotating it on re-enroll costs nothing.
    override_secret = totp.generate_secret()

    if existing:
        node_id = existing[0]
        await db.execute(
            """
            UPDATE nodes SET
                agent_uuid=?, hostname=?, os_type=?, os_version=?, arch=?, agent_version=?,
                enrollment_token_id=?, status='pending', is_active=1,
                override_secret=?, updated_at=datetime('now')
            WHERE id=?
            """,
            (body.agent_uuid, body.hostname, body.os_type, body.os_version, body.arch,
             body.agent_version, token_id, override_secret, node_id),
        )
        # Revoke any previously issued tokens for this node — re-enrollment
        # always mints a fresh one so a lost/leaked old token stops working.
        await db.execute("UPDATE agent_tokens SET revoked=1 WHERE node_id=?", (node_id,))
        if revived:
            log.info(f"Revived decommissioned node {node_id} by serial number match instead of creating a duplicate")
    else:
        async with db.execute(
            """
            INSERT INTO nodes
                (agent_uuid, hostname, os_type, os_version, arch, agent_version,
                 enrollment_token_id, override_secret)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (body.agent_uuid, body.hostname, body.os_type, body.os_version,
             body.arch, body.agent_version, token_id, override_secret),
        ) as cur:
            node_id = cur.lastrowid

    agent_token = secrets.token_urlsafe(32)
    await db.execute(
        "INSERT INTO agent_tokens (node_id, token_hash) VALUES (?, ?)",
        (node_id, hash_agent_token(agent_token)),
    )
    await db.execute(
        "UPDATE enrollment_tokens SET use_count = use_count + 1 WHERE id=?",
        (token_id,),
    )
    await db.commit()

    checkin_interval = await _get_setting_int(db, "agent_checkin_interval_sec", 60)
    return {
        "node_id": node_id,
        "agent_token": agent_token,
        "checkin_interval_sec": checkin_interval,
        "override_secret": override_secret,
    }


# ── Check-in ────────────────────────────────────────────────────────────────

class SoftwareItem(BaseModel):
    name: str
    version: str = ""
    publisher: str = ""
    install_date: str = ""


class ProcessItem(BaseModel):
    pid: int
    name: str
    cpu_pct: float = 0
    mem_mb: float = 0
    username: str = ""


class InterfaceItem(BaseModel):
    name: str
    mac_address: str = ""
    ip_addresses: list[str] = []
    is_up: bool = True


class CheckinRequest(BaseModel):
    hostname: Optional[str] = None
    os_version: Optional[str] = None
    agent_version: Optional[str] = None
    ip_address: Optional[str] = None
    serial_number: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    cpu_model: Optional[str] = None
    cpu_cores: Optional[int] = None
    memory_total_mb: Optional[int] = None
    disk_total_gb: Optional[float] = None
    disk_free_gb: Optional[float] = None
    uptime_seconds: Optional[int] = None
    timezone: Optional[str] = None
    domain_or_workgroup: Optional[str] = None
    current_user: Optional[str] = None

    cpu_pct: Optional[float] = None
    mem_pct: Optional[float] = None
    disk_pct: Optional[float] = None

    # Full inventory refresh is opt-in per check-in (agent decides the
    # cadence) — lightweight heartbeats can omit these entirely.
    full_inventory: bool = False
    software: list[SoftwareItem] = []
    processes: list[ProcessItem] = []
    interfaces: list[InterfaceItem] = []


@router.post("/checkin")
async def checkin(body: CheckinRequest, node: CurrentNode, db: DbDep) -> dict:
    node_id = node["id"]

    fields = {
        "hostname": body.hostname, "os_version": body.os_version,
        "agent_version": body.agent_version, "ip_address": body.ip_address,
        "serial_number": body.serial_number, "manufacturer": body.manufacturer,
        "model": body.model, "cpu_model": body.cpu_model, "cpu_cores": body.cpu_cores,
        "memory_total_mb": body.memory_total_mb, "disk_total_gb": body.disk_total_gb,
        "disk_free_gb": body.disk_free_gb, "uptime_seconds": body.uptime_seconds,
        "timezone": body.timezone, "domain_or_workgroup": body.domain_or_workgroup,
        "current_user": body.current_user,
    }
    set_clauses = [f"{k}=?" for k, v in fields.items() if v is not None]
    values = [v for v in fields.values() if v is not None]
    set_clauses += ["status='online'", "last_checkin_at=datetime('now')", "updated_at=datetime('now')"]
    await db.execute(
        f"UPDATE nodes SET {', '.join(set_clauses)} WHERE id=?", (*values, node_id)
    )

    if body.cpu_pct is not None or body.mem_pct is not None or body.disk_pct is not None:
        await db.execute(
            "INSERT INTO node_metrics_history (node_id, cpu_pct, mem_pct, disk_pct) VALUES (?,?,?,?)",
            (node_id, body.cpu_pct, body.mem_pct, body.disk_pct),
        )

    if body.full_inventory:
        await db.execute("DELETE FROM node_software WHERE node_id=?", (node_id,))
        for item in body.software:
            await db.execute(
                "INSERT INTO node_software (node_id, name, version, publisher, install_date) VALUES (?,?,?,?,?)",
                (node_id, item.name, item.version, item.publisher, item.install_date),
            )

        await db.execute("DELETE FROM node_processes WHERE node_id=?", (node_id,))
        for item in body.processes:
            await db.execute(
                "INSERT INTO node_processes (node_id, pid, name, cpu_pct, mem_mb, username) VALUES (?,?,?,?,?,?)",
                (node_id, item.pid, item.name, item.cpu_pct, item.mem_mb, item.username),
            )

        await db.execute("DELETE FROM node_interfaces WHERE node_id=?", (node_id,))
        for item in body.interfaces:
            await db.execute(
                "INSERT INTO node_interfaces (node_id, name, mac_address, ip_addresses, is_up) VALUES (?,?,?,?,?)",
                (node_id, item.name, item.mac_address, json.dumps(item.ip_addresses), int(item.is_up)),
            )

    # Hand back any commands still waiting for this node, and mark them sent
    # so the next check-in doesn't hand them out again.
    async with db.execute(
        "SELECT id, command_type, payload_json FROM commands WHERE node_id=? AND status='pending'",
        (node_id,),
    ) as cur:
        pending = await cur.fetchall()
    commands = [
        {"id": r[0], "command_type": r[1], "payload": json.loads(r[2] or "{}")}
        for r in pending
    ]
    if commands:
        ids = [c["id"] for c in commands]
        placeholders = ",".join("?" for _ in ids)
        await db.execute(
            f"UPDATE commands SET status='sent', sent_at=datetime('now') WHERE id IN ({placeholders})",
            ids,
        )

    await db.commit()

    checkin_interval = await _get_setting_int(db, "agent_checkin_interval_sec", 60)
    return {"checkin_interval_sec": checkin_interval, "commands": commands}


# ── Command results ──────────────────────────────────────────────────────────

class CommandResultIn(BaseModel):
    status: str = "completed"   # completed | failed
    exit_code: int = 0
    result: str = ""


@router.post("/commands/{command_id}/result")
async def report_command_result(
    command_id: int, body: CommandResultIn, node: CurrentNode, db: DbDep
) -> dict:
    async with db.execute(
        "SELECT id FROM commands WHERE id=? AND node_id=?", (command_id, node["id"])
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Command not found for this node")

    status = "completed" if body.status not in ("completed", "failed") else body.status
    await db.execute(
        """
        UPDATE commands SET status=?, exit_code=?, result_json=?, completed_at=datetime('now')
        WHERE id=?
        """,
        (status, body.exit_code, json.dumps({"output": body.result}), command_id),
    )
    await db.commit()
    return {"ok": True}
