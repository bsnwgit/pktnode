"""FastAPI dependency injection helpers."""
from __future__ import annotations
import hashlib
import secrets
from typing import Annotated, Optional
import aiosqlite
from fastapi import Depends, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from app.database import get_db
from app.auth.local import decode_access_token
from app.config import get_settings

DbDep = Annotated[aiosqlite.Connection, Depends(get_db)]
_bearer = HTTPBearer(auto_error=False)

_SUITE_ROLE_MAP = {"admin": "admin", "analyst": "analyst", "viewer": "viewer"}


async def get_current_user(
    request: Request,
    db: DbDep,
    credentials: Annotated[Optional[HTTPAuthorizationCredentials], Security(_bearer)] = None,
) -> dict:
    settings = get_settings()
    suite_token = request.headers.get("x-suite-token", "")
    if suite_token and settings.suite_token and secrets.compare_digest(suite_token, settings.suite_token):
        hub_user = request.headers.get("x-suite-user", "hub_user")
        hub_role = request.headers.get("x-suite-role", "viewer")
        local_role = _SUITE_ROLE_MAP.get(hub_role, "viewer")
        return {"id": 0, "username": hub_user, "email": f"{hub_user}@pkthub",
                "role": local_role, "is_active": True,
                "created_at": "2020-01-01 00:00:00", "last_login": None, "_via_suite": True}
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_access_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    async with db.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users WHERE id = ?",
        (payload["sub"],),
    ) as cur:
        user = await cur.fetchone()
    if not user or not user["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    return dict(user)


async def require_admin(user: Annotated[dict, Depends(get_current_user)]) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return user

async def require_analyst(user: Annotated[dict, Depends(get_current_user)]) -> dict:
    if user["role"] not in ("admin", "analyst"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Analyst role or higher required")
    return user

CurrentUser = Annotated[dict, Depends(get_current_user)]
AdminUser   = Annotated[dict, Depends(require_admin)]
AnalystUser = Annotated[dict, Depends(require_analyst)]


def hash_agent_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def get_current_node(
    db: DbDep,
    credentials: Annotated[Optional[HTTPAuthorizationCredentials], Security(_bearer)] = None,
) -> dict:
    """
    Agent auth — separate from get_current_user's JWT sessions. Agents
    authenticate with a long-lived per-node bearer token (issued once at
    enrollment, see app/api/agent.py) rather than logging in.
    """
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Agent token required")
    token_hash = hash_agent_token(credentials.credentials)
    async with db.execute(
        """
        SELECT n.* FROM agent_tokens t
        JOIN nodes n ON n.id = t.node_id
        WHERE t.token_hash = ? AND t.revoked = 0
        """,
        (token_hash,),
    ) as cur:
        node = await cur.fetchone()
    if not node:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or revoked agent token")
    await db.execute(
        "UPDATE agent_tokens SET last_used_at = datetime('now') WHERE token_hash = ?",
        (token_hash,),
    )
    await db.commit()
    return dict(node)


CurrentNode = Annotated[dict, Depends(get_current_node)]
