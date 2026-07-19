"""
app/api/alerts.py — Alert rules and alert events REST API
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException, Query, UploadFile
from pydantic import BaseModel

from fastapi import Depends
from app.database import get_db
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()

# ── Helpers ───────────────────────────────────────────────────────────────────

def _row_to_dict(row: aiosqlite.Row) -> dict:
    return dict(row)


# ═══════════════════════════════════════════════════════════════════════════════
# ALERT EVENTS
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/events")
async def list_events(
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
    acked: Optional[bool] = Query(None, description="Filter by acked status"),
    active: Optional[bool] = Query(None, description="If true, only unresolved events"),
    limit: int = Query(200, ge=1, le=2000),
    since: Optional[str] = Query(None, description="ISO datetime lower bound"),
    until: Optional[str] = Query(None, description="ISO datetime upper bound"),
) -> list[dict]:
    db.row_factory = aiosqlite.Row
    clauses = []
    params: list = []

    if acked is not None:
        clauses.append("e.acked_at IS " + ("NOT NULL" if acked else "NULL"))
    if active is True:
        clauses.append("e.resolved_at IS NULL")
    if since:
        # fired_at is stored via SQLite's own datetime('now') (space-separated,
        # no 'Z'/fractional seconds) — wrap the incoming ISO string in datetime()
        # too so the comparison is format-normalized on both sides, not a raw
        # string compare that would silently mismatch on 'T'/'Z'/milliseconds.
        clauses.append("e.fired_at >= datetime(?)")
        params.append(since)
    if until:
        clauses.append("e.fired_at <= datetime(?)")
        params.append(until)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)

    sql = f"""
        SELECT
            e.id, e.severity, e.message, e.details,
            e.fired_at, e.acked_at, e.resolved_at,
            e.node_id,
            r.id   AS rule_id,
            r.name AS rule_name,
            r.rule_type,
            u.username AS acked_by,
            n.hostname   AS node_hostname,
            n.ip_address AS node_ip
        FROM alert_events e
        JOIN  alert_rules r ON r.id = e.rule_id
        LEFT JOIN users   u ON u.id = e.acked_by
        LEFT JOIN nodes   n ON n.id = e.node_id
        {where}
        ORDER BY e.fired_at DESC
        LIMIT ?
    """
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/events/{event_id}/ack")
async def ack_event(
    event_id: int,
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute("SELECT id FROM alert_events WHERE id=?", (event_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Event not found")
    await db.execute(
        "UPDATE alert_events SET acked_at=datetime('now'), acked_by=? WHERE id=?",
        (user["id"], event_id),
    )
    await db.commit()
    return {"ok": True}


@router.post("/events/ack-all")
async def ack_all_events(
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    await db.execute(
        "UPDATE alert_events SET acked_at=datetime('now'), acked_by=? WHERE acked_at IS NULL",
        (user["id"],),
    )
    await db.commit()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
# ALERT RULES
# ═══════════════════════════════════════════════════════════════════════════════

class RuleIn(BaseModel):
    name: str
    description: str = ""
    rule_type: str = "threshold"
    conditions: dict = {}
    time_window_min: int = 5
    severity: str = "warning"
    channels: list[str] = ["inapp"]
    cooldown_min: int = 30
    enabled: bool = True


@router.get("/rules")
async def list_rules(
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> list[dict]:
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT * FROM alert_rules ORDER BY id"
    ) as cur:
        rows = await cur.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        # Parse JSON fields
        try:
            d["conditions"] = json.loads(d["conditions"])
        except Exception:
            d["conditions"] = {}
        try:
            d["channels"] = json.loads(d["channels"])
        except Exception:
            d["channels"] = ["inapp"]
        result.append(d)
    return result


@router.post("/rules", status_code=201)
async def create_rule(
    body: RuleIn,
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute(
        """
        INSERT INTO alert_rules
            (name, description, rule_type, conditions, time_window_min,
             severity, channels, cooldown_min, enabled, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        (
            body.name, body.description, body.rule_type,
            json.dumps(body.conditions), body.time_window_min,
            body.severity, json.dumps(body.channels),
            body.cooldown_min, int(body.enabled), user["id"],
        ),
    ) as cur:
        rule_id = cur.lastrowid
    await db.commit()
    return {"id": rule_id}


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: int,
    body: RuleIn,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute("SELECT id FROM alert_rules WHERE id=?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.execute(
        """
        UPDATE alert_rules SET
            name=?, description=?, rule_type=?, conditions=?,
            time_window_min=?, severity=?, channels=?, cooldown_min=?,
            enabled=?, updated_at=datetime('now')
        WHERE id=?
        """,
        (
            body.name, body.description, body.rule_type,
            json.dumps(body.conditions), body.time_window_min,
            body.severity, json.dumps(body.channels),
            body.cooldown_min, int(body.enabled), rule_id,
        ),
    )
    await db.commit()
    return {"ok": True}


@router.post("/rules/{rule_id}/toggle")
async def toggle_rule(
    rule_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute("SELECT id, enabled FROM alert_rules WHERE id=?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Rule not found")
    new_val = 0 if row[1] else 1
    await db.execute(
        "UPDATE alert_rules SET enabled=?, updated_at=datetime('now') WHERE id=?",
        (new_val, rule_id),
    )
    await db.commit()
    return {"enabled": bool(new_val)}


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    async with db.execute("SELECT id FROM alert_rules WHERE id=?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.execute("DELETE FROM alert_events WHERE rule_id=?", (rule_id,))
    await db.execute("DELETE FROM alert_rules WHERE id=?", (rule_id,))
    await db.commit()


@router.get("/rules/export")
async def export_rules(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Export all alert rules as a CSV file download."""
    import csv
    import io
    from fastapi.responses import StreamingResponse

    db.row_factory = aiosqlite.Row
    async with db.execute(
        """SELECT name, description, rule_type, conditions, time_window_min,
                  severity, channels, cooldown_min, enabled
           FROM alert_rules ORDER BY id"""
    ) as cur:
        rows = await cur.fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "name", "description", "rule_type", "conditions", "time_window_min",
        "severity", "channels", "cooldown_min", "enabled",
    ])
    for r in rows:
        try:
            channels = ",".join(json.loads(r["channels"]))
        except Exception:
            channels = "inapp"
        writer.writerow([
            r["name"], r["description"] or "", r["rule_type"],
            r["conditions"] or "{}", r["time_window_min"],
            r["severity"], channels, r["cooldown_min"],
            "true" if r["enabled"] else "false",
        ])
    buf.seek(0)
    return StreamingResponse(
        io.BytesIO(buf.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="pktnode-alert-rules.csv"'},
    )


@router.post("/rules/import-csv")
async def import_rules_csv(
    file: UploadFile,
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    """Import alert rules from a multipart CSV upload.

    CSV columns (header row required):
      name, description, rule_type, conditions, time_window_min, severity,
      channels, cooldown_min, enabled

    - conditions: a JSON object string, e.g. '{"threshold_pct": 90}' — the
      exact shape depends on rule_type, same as the "conditions" the UI builds.
      Blank or invalid JSON is treated as {}.
    - channels: comma-separated, e.g. "inapp,slack". Blank defaults to "inapp".
    - Rows are always inserted as new rules (no de-dup by name — multiple
      rules can legitimately share a name/type scoped to different nodes).
    """
    import csv, io

    raw = await file.read()
    text = raw.decode("utf-8-sig")  # strip BOM (Excel exports)

    reader = csv.DictReader(io.StringIO(text))
    created = 0
    skipped = 0
    errors: list[str] = []

    for lineno, row in enumerate(reader, start=2):
        name = (row.get("name") or "").strip()
        rule_type = (row.get("rule_type") or "").strip()
        if not name or not rule_type:
            errors.append(f"Row {lineno}: missing name or rule_type — skipped")
            skipped += 1
            continue

        conditions_raw = (row.get("conditions") or "").strip()
        try:
            conditions = json.loads(conditions_raw) if conditions_raw else {}
            if not isinstance(conditions, dict):
                raise ValueError("conditions must be a JSON object")
        except Exception as exc:
            errors.append(f"Row {lineno}: {name}: invalid conditions JSON ({exc}) — skipped")
            skipped += 1
            continue

        channels_raw = (row.get("channels") or "inapp").strip()
        channels = [c.strip() for c in channels_raw.split(",") if c.strip()] or ["inapp"]

        time_window_str = (row.get("time_window_min") or "5").strip()
        time_window_min = int(time_window_str) if time_window_str.lstrip("-").isdigit() else 5

        cooldown_str = (row.get("cooldown_min") or "30").strip()
        cooldown_min = int(cooldown_str) if cooldown_str.lstrip("-").isdigit() else 30

        enabled_str = (row.get("enabled") or "true").strip().lower()
        enabled = enabled_str not in ("false", "0", "no")

        try:
            await db.execute(
                """INSERT INTO alert_rules
                    (name, description, rule_type, conditions, time_window_min,
                     severity, channels, cooldown_min, enabled, created_by)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    name, (row.get("description") or "").strip(), rule_type,
                    json.dumps(conditions), time_window_min,
                    (row.get("severity") or "warning").strip(), json.dumps(channels),
                    cooldown_min, int(enabled), user["id"],
                ),
            )
            created += 1
        except Exception as exc:
            errors.append(f"Row {lineno}: {name}: {exc}")
            skipped += 1

    await db.commit()
    return {"created": created, "skipped": skipped, "errors": errors}
