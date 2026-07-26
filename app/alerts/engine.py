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

Overrides, most specific wins:
  1. Per-node override (node_offline only — nodes.alert_host_down_override).
  2. Per-group override (group_alert_overrides — groups are created in
     Settings -> Groups; a node's membership is a list of group names in
     nodes.tags_json and it can be in more than one; when a node's groups
     disagree on the same field, the group with the higher row id wins,
     i.e. whichever override was saved most recently). An override targets
     one specific alert_rules row (rule_id), not a rule_type as a whole,
     since there can be more than one rule of the same type.
  3. The rule's own default (settings.alert_host_down_enabled for
     node_offline; conditions.threshold_pct for the rest).

Turning a rule off for a node — by any of the above — also auto-resolves any
event already open for it, not just future evaluations.

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

    async def _get_setting_bool(self, db: aiosqlite.Connection, key: str, default: bool) -> bool:
        async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
        if not row:
            return default
        try:
            return bool(json.loads(row[0]))
        except (ValueError, TypeError):
            return default

    async def _group_overrides(self, db: aiosqlite.Connection, rule_id: int) -> list[aiosqlite.Row]:
        async with db.execute(
            "SELECT * FROM group_alert_overrides WHERE rule_id=? ORDER BY id", (rule_id,)
        ) as cur:
            return await cur.fetchall()

    @staticmethod
    def _parse_tags(raw) -> list[str]:
        try:
            return json.loads(raw or "[]")
        except (ValueError, TypeError):
            return []

    @staticmethod
    def _resolve_group_override(
        tags: list[str], overrides: list[aiosqlite.Row]
    ) -> tuple[Optional[bool], Optional[float]]:
        """Later (higher-id) matching group rows win per-field, independently —
        one group can supply `enabled` while another supplies `threshold_pct`."""
        enabled: Optional[bool] = None
        threshold: Optional[float] = None
        tagset = set(tags)
        for o in overrides:
            if o["group_name"] in tagset:
                if o["enabled"] is not None:
                    enabled = bool(o["enabled"])
                if o["threshold_pct"] is not None:
                    threshold = o["threshold_pct"]
        return enabled, threshold

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
        global_enabled = await self._get_setting_bool(db, "alert_host_down_enabled", True)
        offline_after = await self._get_setting_int(db, "offline_after_sec", 300)
        group_overrides = await self._group_overrides(db, rule["id"])

        def effective_enabled(tags_json, node_override) -> bool:
            if node_override is not None:
                return bool(node_override)
            group_enabled, _ = self._resolve_group_override(self._parse_tags(tags_json), group_overrides)
            if group_enabled is not None:
                return group_enabled
            return global_enabled

        async with db.execute(
            """
            SELECT id, hostname, tags_json, alert_host_down_override FROM nodes
            WHERE is_active=1 AND last_checkin_at IS NOT NULL
              AND last_checkin_at < datetime('now', ?)
            """,
            (f"-{offline_after} seconds",),
        ) as cur:
            offline_nodes = await cur.fetchall()
        for n in offline_nodes:
            if effective_enabled(n["tags_json"], n["alert_host_down_override"]):
                await self._fire(db, rule, n["id"], f"{n['hostname']} has not checked in", None)

        # Auto-resolve: node's back within the threshold, or decommissioned.
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

        # Auto-resolve: still offline, but alerting is now suppressed for this
        # node (globally, via its own override, or via a group it's in).
        async with db.execute(
            """
            SELECT DISTINCT e.node_id, n.tags_json, n.alert_host_down_override FROM alert_events e
            JOIN nodes n ON n.id = e.node_id
            WHERE e.rule_id=? AND e.resolved_at IS NULL
            """,
            (rule["id"],),
        ) as cur:
            still_open = await cur.fetchall()
        for r in still_open:
            if not effective_enabled(r["tags_json"], r["alert_host_down_override"]):
                await self._resolve_open(db, rule["id"], r["node_id"])

    async def _eval_disk_low(self, db: aiosqlite.Connection, rule: aiosqlite.Row, conditions: dict) -> None:
        base_threshold = float(conditions.get("threshold_pct", 10))
        group_overrides = await self._group_overrides(db, rule["id"])
        async with db.execute(
            """
            SELECT id, hostname, disk_total_gb, disk_free_gb, tags_json FROM nodes
            WHERE is_active=1 AND disk_total_gb IS NOT NULL AND disk_total_gb > 0
            """
        ) as cur:
            nodes = await cur.fetchall()
        for n in nodes:
            enabled, threshold = self._resolve_group_override(self._parse_tags(n["tags_json"]), group_overrides)
            if enabled is False:
                await self._resolve_open(db, rule["id"], n["id"])
                continue
            threshold_pct = base_threshold if threshold is None else threshold
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
        base_threshold = float(conditions.get("threshold_pct", 90))
        window_min = rule["time_window_min"] or 5
        group_overrides = await self._group_overrides(db, rule["id"])
        async with db.execute(
            """
            SELECT n.id, n.hostname, n.tags_json, AVG(h.{col}) AS avg_val
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
            enabled, threshold = self._resolve_group_override(self._parse_tags(r["tags_json"]), group_overrides)
            if enabled is False:
                await self._resolve_open(db, rule["id"], r["id"])
                continue
            threshold_pct = base_threshold if threshold is None else threshold
            if r["avg_val"] > threshold_pct:
                await self._fire(
                    db, rule, r["id"],
                    f"{r['hostname']} {metric_label} averaged {r['avg_val']:.1f}% over {window_min}m "
                    f"(above {threshold_pct:.0f}%)",
                    r["avg_val"],
                )
            else:
                await self._resolve_open(db, rule["id"], r["id"])
