"""
app/api/groups.py — "Groups" REST API.

Groups are a real, explicitly-created entity (see migrations/010_groups_table.sql)
managed from Settings -> Groups — that's the only place one gets created or
deleted. A node's membership is still just a list of group names in
nodes.tags_json (see app/api/nodes.py's NodeUpdate.tags — a node can be in
more than one), but nodes.py validates every value against this table so a
node can never end up "in" a group that doesn't exist.

This module also owns per-group alert overrides, which app/alerts/engine.py
consults alongside each rule's own default and, for node_offline, the
per-node override on the node itself. An override targets one specific
alert_rules row (rule_id), not just a rule_type — there can be more than one
rule of the same type (e.g. two disk_low rules at different severities), and
a type-wide override couldn't tell them apart.
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.dependencies import AdminUser, AnalystUser, DbDep

router = APIRouter()


@router.get("/")
async def list_groups(_: AnalystUser, db: DbDep) -> list[dict]:
    """Every created group, with its live member count and any alert overrides."""
    async with db.execute("SELECT name FROM groups ORDER BY name") as cur:
        names = [r["name"] for r in await cur.fetchall()]

    async with db.execute("SELECT tags_json FROM nodes WHERE is_active=1") as cur:
        node_rows = await cur.fetchall()
    counts: dict[str, int] = {n: 0 for n in names}
    for row in node_rows:
        try:
            tags = json.loads(row["tags_json"] or "[]")
        except (ValueError, TypeError):
            tags = []
        for t in tags:
            if t in counts:
                counts[t] += 1

    async with db.execute("SELECT * FROM group_alert_overrides ORDER BY id") as cur:
        override_rows = await cur.fetchall()
    by_group: dict[str, list[dict]] = {}
    for o in override_rows:
        d = dict(o)
        d["enabled"] = None if d["enabled"] is None else bool(d["enabled"])
        by_group.setdefault(d["group_name"], []).append(d)

    return [
        {"name": n, "member_count": counts[n], "overrides": by_group.get(n, [])}
        for n in names
    ]


class GroupCreate(BaseModel):
    name: str


@router.post("/")
async def create_group(body: GroupCreate, _: AdminUser, db: DbDep) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Group name is required")
    try:
        await db.execute("INSERT INTO groups (name) VALUES (?)", (name,))
        await db.commit()
    except aiosqlite.IntegrityError:
        raise HTTPException(409, "A group with that name already exists")
    return {"ok": True, "name": name}


@router.delete("/{group_name}")
async def delete_group(group_name: str, _: AdminUser, db: DbDep) -> dict:
    async with db.execute("SELECT id FROM groups WHERE name=?", (group_name,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(404, "Group not found")

    # Cascades to group_alert_overrides via FK; still need to strip it out of
    # every node's own membership list.
    await db.execute("DELETE FROM groups WHERE name=?", (group_name,))
    async with db.execute("SELECT id, tags_json FROM nodes") as cur:
        all_nodes = await cur.fetchall()
    for n in all_nodes:
        try:
            tags = json.loads(n["tags_json"] or "[]")
        except (ValueError, TypeError):
            tags = []
        if group_name in tags:
            tags = [t for t in tags if t != group_name]
            await db.execute(
                "UPDATE nodes SET tags_json=?, updated_at=datetime('now') WHERE id=?",
                (json.dumps(tags), n["id"]),
            )
    await db.commit()
    return {"ok": True}


class OverrideUpdate(BaseModel):
    enabled: Optional[bool] = None
    threshold_pct: Optional[float] = None


@router.put("/{group_name}/overrides/{rule_id}")
async def set_group_override(
    group_name: str, rule_id: int, body: OverrideUpdate, _: AdminUser, db: DbDep
) -> dict:
    async with db.execute("SELECT id FROM groups WHERE name=?", (group_name,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(404, "Group not found")
    async with db.execute("SELECT id FROM alert_rules WHERE id=?", (rule_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(404, "Alert rule not found")

    if body.enabled is None and body.threshold_pct is None:
        # Nothing to inherit from anymore — just drop the row.
        await db.execute(
            "DELETE FROM group_alert_overrides WHERE group_name=? AND rule_id=?",
            (group_name, rule_id),
        )
    else:
        enabled_val = None if body.enabled is None else int(body.enabled)
        await db.execute(
            """
            INSERT INTO group_alert_overrides (group_name, rule_id, enabled, threshold_pct, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(group_name, rule_id) DO UPDATE SET
                enabled=excluded.enabled, threshold_pct=excluded.threshold_pct, updated_at=datetime('now')
            """,
            (group_name, rule_id, enabled_val, body.threshold_pct),
        )
    await db.commit()
    return {"ok": True}
