"""
Enrollment token staleness cleanup.

Runs once per day. Deletes limited-use enrollment tokens (max_uses is set
— shared/unlimited rollout links are exempt, same exemption the /enroll
handler already applies) that have sat completely unused for more than
_STALE_AFTER_DAYS, plus any token past its own expires_at. Either case
means the token can never enroll anything again, so there's nothing worth
keeping — deleted outright, same as a token the /enroll handler sees go
fully spent, or one the check-in handler confirms was actually used (see
app/api/agent.py). Manually-revoked tokens are untouched here — that's a
deliberate admin action with its own Revoked-tab audit trail, not this
job's concern.

This is a staleness heuristic, not host-tracking: there's no reliable way
to tell "a node matching this token's intended target already enrolled
through a different token" — a token's label is free-text set at creation
time and isn't guaranteed to match the enrolling host's actual hostname.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

import aiosqlite

from app.config import get_settings

log = logging.getLogger("pktnode.enrollment_cleanup")
settings = get_settings()

_CLEANUP_INTERVAL = 86_400  # once per day
_STALE_AFTER_DAYS = 7


class EnrollmentCleanup:
    _instance: "Optional[EnrollmentCleanup]" = None

    def __init__(self, interval_seconds: int = _CLEANUP_INTERVAL):
        self._interval = interval_seconds
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        EnrollmentCleanup._instance = self
        self._task = asyncio.create_task(self._run_loop())
        log.info(f"Enrollment token cleanup started (interval={self._interval}s)")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run_loop(self) -> None:
        while True:
            try:
                await self._cleanup()
            except Exception as e:
                log.error(f"Enrollment token cleanup error: {e}")
            await asyncio.sleep(self._interval)

    async def _cleanup(self) -> None:
        db_path = settings.db_path
        async with aiosqlite.connect(db_path) as db:
            result = await db.execute(
                """
                DELETE FROM enrollment_tokens
                WHERE revoked = 0
                  AND (
                    (max_uses IS NOT NULL AND use_count = 0 AND created_at < datetime('now', ?))
                    OR (expires_at IS NOT NULL AND expires_at < datetime('now'))
                  )
                """,
                (f"-{_STALE_AFTER_DAYS} days",),
            )
            deleted = result.rowcount
            await db.commit()

        if deleted > 0:
            log.info(f"Enrollment token cleanup: deleted {deleted} stale/expired token(s)")
        else:
            log.debug("Enrollment token cleanup: nothing to delete")
