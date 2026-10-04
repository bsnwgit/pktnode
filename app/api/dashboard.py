"""
/api/dashboard — everything the Dashboard page's charts draw, in one read.

One request instead of one per panel, so the trend, the leaderboards and the
disk list all describe the same moment rather than landing a poll apart and
disagreeing with each other. The node counts and the recently-seen table stay
on /api/nodes — this is only the history-derived half.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Query

from app.api.nodes import _get_setting_int
from app.api.settings import disk_exclusions, drive_excluded
from app.dependencies import AdminUser, CurrentUser, DbDep

router = APIRouter()

# Window (hours) -> bucket width (seconds). A bucket has to be wider than the
# longest gap between two check-ins, or buckets land between samples and the
# line breaks into dots; each step keeps the point count at 60-170.
_BUCKET_SECONDS = {1: 60, 6: 300, 24: 900, 168: 3600}
_TOP_N = 8


def _bucket_for(hours: int) -> int:
    for limit in sorted(_BUCKET_SECONDS):
        if hours <= limit:
            return _BUCKET_SECONDS[limit]
    return 3600


def _utc(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


async def _trend(db: aiosqlite.Connection, since: str, bucket: int) -> list[dict]:
    """Fleet-wide series. Inside a bucket each node's samples are averaged
    first, and only then combined across nodes — otherwise a node that checks
    in more often would weigh more than one that checks in rarely."""
    async with db.execute(
        """SELECT b, AVG(cpu) AS cpu, AVG(mem) AS mem, AVG(disk) AS disk, COUNT(*) AS nodes
           FROM (SELECT CAST(strftime('%s', h.recorded_at) AS INTEGER) / ? AS b, h.node_id,
                        AVG(h.cpu_pct) AS cpu, AVG(h.mem_pct) AS mem, AVG(h.disk_pct) AS disk
                 FROM node_metrics_history h JOIN nodes n ON n.id = h.node_id
                 WHERE n.is_active = 1 AND h.recorded_at >= ?
                 GROUP BY b, h.node_id)
           GROUP BY b ORDER BY b""",
        (bucket, since),
    ) as cur:
        rows = {r["b"]: dict(r) for r in await cur.fetchall()}

    # Throughput is additive — the fleet's traffic is the sum of its nodes' —
    # so this one sums across nodes where the resources above average.
    async with db.execute(
        """SELECT b, SUM(sent) AS sent, SUM(recv) AS recv
           FROM (SELECT CAST(strftime('%s', h.recorded_at) AS INTEGER) / ? AS b, h.node_id,
                        AVG(h.sent_mbps) AS sent, AVG(h.recv_mbps) AS recv
                 FROM node_network_history h JOIN nodes n ON n.id = h.node_id
                 WHERE n.is_active = 1 AND h.recorded_at >= ?
                 GROUP BY b, h.node_id)
           GROUP BY b ORDER BY b""",
        (bucket, since),
    ) as cur:
        net = {r["b"]: dict(r) for r in await cur.fetchall()}

    out = []
    for b in sorted(set(rows) | set(net)):
        r, n = rows.get(b, {}), net.get(b, {})
        out.append({
            "t": b * bucket * 1000,
            "cpu": r.get("cpu"), "mem": r.get("mem"), "disk": r.get("disk"),
            "sent": n.get("sent"), "recv": n.get("recv"),
            "nodes": r.get("nodes", 0),
        })
    return out


async def _latest_top(db: aiosqlite.Connection, column: str, fresh_since: str) -> list[dict]:
    # Latest sample per node, and only a recent one: an offline node keeps its
    # last reading forever, and a leaderboard of machines that have since gone
    # dark would be reporting load that no longer exists.
    async with db.execute(
        f"""SELECT n.id, n.hostname, n.display_name, h.{column} AS v
            FROM node_metrics_history h
            JOIN (SELECT node_id, MAX(recorded_at) AS mx
                  FROM node_metrics_history GROUP BY node_id) l
              ON l.node_id = h.node_id AND l.mx = h.recorded_at
            JOIN nodes n ON n.id = h.node_id
            WHERE n.is_active = 1 AND h.{column} IS NOT NULL AND h.recorded_at >= ?
            ORDER BY h.{column} DESC LIMIT ?""",
        (fresh_since, _TOP_N),
    ) as cur:
        return [
            {"id": r["id"], "name": r["display_name"] or r["hostname"], "value": r["v"]}
            for r in await cur.fetchall()
        ]


@router.get("/drives")
async def list_drives(_: AdminUser, db: DbDep) -> list[dict]:
    """Every drive the fleet reports, one row per node and mount — what the
    Settings page offers as tick-boxes for the ignored-drives list."""
    db.row_factory = aiosqlite.Row
    async with db.execute(
        """SELECT n.id AS node_id, n.hostname, n.display_name, d.mount_point AS mount, d.used_pct
           FROM node_disks d JOIN nodes n ON n.id = d.node_id
           WHERE n.is_active = 1
           ORDER BY COALESCE(n.display_name, n.hostname), d.mount_point"""
    ) as cur:
        return [
            {"node_id": r["node_id"], "name": r["display_name"] or r["hostname"],
             "mount": r["mount"], "used_pct": r["used_pct"]}
            for r in await cur.fetchall()
        ]


@router.get("")
async def get_dashboard(
    _: CurrentUser,
    db: DbDep,
    hours: int = Query(6, ge=1, le=168),
) -> dict:
    db.row_factory = aiosqlite.Row
    now = datetime.now(timezone.utc)
    bucket = _bucket_for(hours)
    offline_after = await _get_setting_int(db, "offline_after_sec", 300)
    fresh_since = _utc(now - timedelta(seconds=offline_after))

    trend = await _trend(db, _utc(now - timedelta(hours=hours)), bucket)

    async with db.execute(
        """SELECT COALESCE(NULLIF(os_type, ''), 'unknown') AS os, COUNT(*) AS n
           FROM nodes WHERE is_active = 1 GROUP BY os ORDER BY n DESC"""
    ) as cur:
        by_os = [{"os": r["os"], "count": r["n"]} for r in await cur.fetchall()]

    async with db.execute(
        """SELECT n.id, n.hostname, n.display_name, d.mount_point, d.used_pct, d.free_gb, d.total_gb
           FROM node_disks d JOIN nodes n ON n.id = d.node_id
           WHERE n.is_active = 1 AND d.used_pct IS NOT NULL
           ORDER BY d.used_pct DESC"""
    ) as cur:
        # Filtered here rather than in SQL: the patterns are shell globs, and
        # the cut to the top few has to come after them or excluded volumes
        # would still use up the slots.
        patterns, ignored = await disk_exclusions(db)
        disks = [
            {"id": r["id"], "name": r["display_name"] or r["hostname"], "mount": r["mount_point"],
             "used_pct": r["used_pct"], "free_gb": r["free_gb"], "total_gb": r["total_gb"]}
            for r in await cur.fetchall()
            if not drive_excluded(r["id"], r["mount_point"], patterns, ignored)
        ][:_TOP_N]

    return {
        "hours": hours,
        "bucket_seconds": bucket,
        "trend": trend,
        "top_cpu": await _latest_top(db, "cpu_pct", fresh_since),
        "top_mem": await _latest_top(db, "mem_pct", fresh_since),
        "disks": disks,
        "by_os": by_os,
    }
