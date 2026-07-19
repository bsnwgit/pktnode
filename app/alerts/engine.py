"""
Alert engine — evaluates alert rules on a schedule and fires/resolves alert events.

Runs every 60 seconds. Implements:
  - node_offline:  fires when an active node's last check-in is older than the
                    configured offline threshold (settings.offline_after_sec).
                    Auto-resolves on the node's next check-in.
  - disk_low:      fires when free disk space (as a % of disk_total_gb) drops
                    below conditions.threshold_pct. Auto-resolves when it
                    recovers above threshold.
  - cpu_high:      fires when the node's mean CPU % over the rule's
                    time_window_min stays above conditions.threshold_pct.
  - mem_high:      same as cpu_high, for memory %.

One rule fires at most one open (unresolved) event per node at a time —
re-evaluation just leaves the existing event open until the condition clears.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

import aiosqlite

from app.config import get_settings

log = logging.getLogger("pktnode.alerts.engine")


class AlertEngine:
    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()
        self._interval: int = 60  # evaluate rules every 60 seconds
        self._db_path: str = ""

    async def start(self, db_path: str) -> None:
        self._db_path = db_path
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self._evaluate_once()
            except Exception:
                log.exception("Alert engine evaluation failed")
            await asyncio.sleep(self._interval)

    async def _get_setting_int(self, db: aiosqlite.Connection, key: str, default: int) -> int:
        async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
        if not row:
            return default
        try:
            return int(json.loads(row[0]))
        except (ValueError, TypeError):
            return default

    async def _fire(
        self, db: aiosqlite.Connection, rule: aiosqlite.Row, node_id: int, message: str, value: Optional[float]
    ) -> None:
        async with db.execute(
            "SELECT id FROM alert_events WHERE rule_id=? AND node_id=? AND resolved_at IS NULL",
            (rule["id"], node_id),
        ) as cur:
            existing = await cur.fetchone()
        if existing:
            return  # already firing — leave it open
        await db.execute(
            """
            INSERT INTO alert_events (rule_id, node_id, severity, message, details)
            VALUES (?,?,?,?,?)
            """,
            (rule["id"], node_id, rule["severity"], message, json.dumps({"value": value})),
        )
        await db.execute(
            "UPDATE alert_rules SET last_fired=datetime('now') WHERE id=?", (rule["id"],)
        )
        log.info(f"Alert fired: rule={rule['name']} node_id={node_id} — {message}")

    async def _resolve_open(self, db: aiosqlite.Connection, rule_id: int, node_id: int) -> None:
        await db.execute(
            """
            UPDATE alert_events SET resolved_at=datetime('now'), auto_resolved=1
            WHERE rule_id=? AND node_id=? AND resolved_at IS NULL
            """,
            (rule_id, node_id),
        )

    async def _evaluate_once(self) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row

            async with db.execute(
                "SELECT * FROM alert_rules WHERE enabled=1"
            ) as cur:
                rules = await cur.fetchall()

            for rule in rules:
                try:
                    conditions = json.loads(rule["conditions"] or "{}")
                except (ValueError, TypeError):
                    conditions = {}

                if rule["rule_type"] == "node_offline":
                    await self._eval_node_offline(db, rule)
                elif rule["rule_type"] == "disk_low":
                    await self._eval_disk_low(db, rule, conditions)
                elif rule["rule_type"] == "cpu_high":
                    await self._eval_metric_high(db, rule, conditions, "cpu_pct")
                elif rule["rule_type"] == "mem_high":
                    await self._eval_metric_high(db, rule, conditions, "mem_pct")

            await db.commit()

    async def _eval_node_offline(self, db: aiosqlite.Connection, rule: aiosqlite.Row) -> None:
        offline_after = await self._get_setting_int(db, "offline_after_sec", 300)
        async with db.execute(
            """
            SELECT id, hostname FROM nodes
            WHERE is_active=1 AND last_checkin_at IS NOT NULL
              AND last_checkin_at < datetime('now', ?)
            """,
            (f"-{offline_after} seconds",),
        ) as cur:
            offline_nodes = await cur.fetchall()
        for n in offline_nodes:
            await self._fire(db, rule, n["id"], f"{n['hostname']} has not checked in", None)

        # Auto-resolve: any node that's back within the threshold clears its open event.
        async with db.execute(
            """
            SELECT DISTINCT e.node_id FROM alert_events e
            JOIN nodes n ON n.id = e.node_id
            WHERE e.rule_id=? AND e.resolved_at IS NULL
              AND (n.is_active=0 OR n.last_checkin_at >= datetime('now', ?))
            """,
            (rule["id"], f"-{offline_after} seconds"),
        ) as cur:
            recovered = await cur.fetchall()
        for r in recovered:
            await self._resolve_open(db, rule["id"], r["node_id"])

    async def _eval_disk_low(self, db: aiosqlite.Connection, rule: aiosqlite.Row, conditions: dict) -> None:
        threshold_pct = float(conditions.get("threshold_pct", 10))
        async with db.execute(
            """
            SELECT id, hostname, disk_total_gb, disk_free_gb FROM nodes
            WHERE is_active=1 AND disk_total_gb IS NOT NULL AND disk_total_gb > 0
            """
        ) as cur:
            nodes = await cur.fetchall()
        for n in nodes:
            free_pct = (n["disk_free_gb"] or 0) / n["disk_total_gb"] * 100
            if free_pct < threshold_pct:
                await self._fire(
                    db, rule, n["id"],
                    f"{n['hostname']} has {free_pct:.1f}% free disk (below {threshold_pct:.0f}%)",
                    free_pct,
                )
            else:
                await self._resolve_open(db, rule["id"], n["id"])

    async def _eval_metric_high(
        self, db: aiosqlite.Connection, rule: aiosqlite.Row, conditions: dict, column: str
    ) -> None:
        threshold_pct = float(conditions.get("threshold_pct", 90))
        window_min = rule["time_window_min"] or 5
        async with db.execute(
            """
            SELECT n.id, n.hostname, AVG(h.{col}) AS avg_val
            FROM nodes n
            JOIN node_metrics_history h ON h.node_id = n.id
            WHERE n.is_active=1 AND h.recorded_at >= datetime('now', ?)
            GROUP BY n.id
            HAVING avg_val IS NOT NULL
            """.format(col=column),
            (f"-{window_min} minutes",),
        ) as cur:
            rows = await cur.fetchall()
        metric_label = "CPU" if column == "cpu_pct" else "memory"
        for r in rows:
            if r["avg_val"] > threshold_pct:
                await self._fire(
                    db, rule, r["id"],
                    f"{r['hostname']} {metric_label} averaged {r['avg_val']:.1f}% over {window_min}m "
                    f"(above {threshold_pct:.0f}%)",
                    r["avg_val"],
                )
            else:
                await self._resolve_open(db, rule["id"], r["id"])
