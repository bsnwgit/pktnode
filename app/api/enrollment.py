"""
app/api/enrollment.py — Enrollment token management (admin-only).

Enrollment tokens are shared secrets baked into the agent installer at
install time. The agent exchanges one for its own per-node agent_token via
POST /api/agent/enroll (see app/api/agent.py) and never uses the enrollment
token again after that.
"""
from __future__ import annotations

import hashlib
import secrets
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import AdminUser, DbDep

router = APIRouter()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class EnrollmentTokenIn(BaseModel):
    label: str = ""
    expires_in_days: Optional[int] = None
    max_uses: Optional[int] = None


@router.get("/tokens")
async def list_tokens(_: AdminUser, db: DbDep) -> list[dict]:
    db.row_factory = aiosqlite.Row
    async with db.execute(
        """
        SELECT et.id, et.label, et.created_at, et.expires_at, et.max_uses,
               et.use_count, et.revoked, et.revoked_at, u.username AS created_by,
               (SELECT COUNT(*) FROM nodes WHERE enrollment_token_id = et.id AND is_active = 1) AS nodes_enrolled
        FROM enrollment_tokens et
        LEFT JOIN users u ON u.id = et.created_by
        ORDER BY et.created_at DESC
        """
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/tokens", status_code=201)
async def create_token(body: EnrollmentTokenIn, user: AdminUser, db: DbDep) -> dict:
    """
    Create a new enrollment token. The raw token is returned exactly once —
    only its hash is stored, so it can't be retrieved again after this call.
    """
    raw_token = secrets.token_urlsafe(32)
    expires_at = None
    if body.expires_in_days is not None:
        async with db.execute(
            "SELECT datetime('now', ?)", (f"+{int(body.expires_in_days)} days",)
        ) as cur:
            row = await cur.fetchone()
            expires_at = row[0]

    async with db.execute(
        """
        INSERT INTO enrollment_tokens (token_hash, label, created_by, expires_at, max_uses)
        VALUES (?, ?, ?, ?, ?)
        """,
        (_hash_token(raw_token), body.label, user["id"], expires_at, body.max_uses),
    ) as cur:
        token_id = cur.lastrowid
    await db.commit()

    return {"id": token_id, "token": raw_token, "expires_at": expires_at}


@router.post("/tokens/{token_id}/rotate")
async def rotate_token(token_id: int, _: AdminUser, db: DbDep) -> dict:
    """
    Generate a fresh raw secret for this same token record — the only way
    to get an install command for a token again once the original raw
    value was dismissed (the server only ever stores a hash, never the
    plaintext, so the old value genuinely can't be shown again). Keeps the
    label/expiry/max-uses policy and enrolled-node history; resets
    use_count back to 0 so a fully-used token is immediately usable again
    rather than still reporting itself exhausted.
    """
    async with db.execute(
        "SELECT id, revoked FROM enrollment_tokens WHERE id=?", (token_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Token not found")
    if row[1]:
        raise HTTPException(status_code=400, detail="Token is revoked — delete it and create a new one instead")

    raw_token = secrets.token_urlsafe(32)
    await db.execute(
        "UPDATE enrollment_tokens SET token_hash=?, use_count=0 WHERE id=?",
        (_hash_token(raw_token), token_id),
    )
    await db.commit()
    return {"token": raw_token}


@router.post("/tokens/{token_id}/revoke")
async def revoke_token(token_id: int, _: AdminUser, db: DbDep) -> dict:
    async with db.execute("SELECT id FROM enrollment_tokens WHERE id=?", (token_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Token not found")
    await db.execute(
        "UPDATE enrollment_tokens SET revoked=1, revoked_at=datetime('now') WHERE id=?",
        (token_id,),
    )
    await db.commit()
    return {"ok": True}


@router.delete("/tokens/{token_id}", status_code=204)
async def delete_token(token_id: int, _: AdminUser, db: DbDep) -> None:
    async with db.execute("SELECT id FROM enrollment_tokens WHERE id=?", (token_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Token not found")
    await db.execute("DELETE FROM enrollment_tokens WHERE id=?", (token_id,))
    await db.commit()
