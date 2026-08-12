"""
pktNode — FastAPI application entry point.
"""
from __future__ import annotations

import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db, seed_admin

# ── Routers ───────────────────────────────────────────────────────────────────
from app.api import (
    nodes as nodes_router,
    enrollment as enrollment_router,
    agent as agent_router,
    settings as settings_router,
    auth,
    users,
    system as system_router,
)
from app.api import suite as suite_router
from app.api import logs as logs_router
from app.api import alerts as alerts_router
from app.api import user_api_keys as user_api_keys_router
from app.api import ip_info as ip_info_router
from app.api import mxtoolbox as mxtoolbox_router
from app.api import groups as groups_router
from app.api import widgets as widgets_router
from app.api import docs as docs_router

settings = get_settings()
log = logging.getLogger("pktnode")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    # ── Startup ───────────────────────────────────────────────────────────────
    # Attach SQLite log handler before anything else so startup events are captured.
    from app.logging_handler import SQLiteLogHandler
    _log_handler = SQLiteLogHandler(db_path=settings.db_path)
    _log_handler.attach_to_root_logger("pktnode")

    log.info("pktNode starting up")
    # Ship our own logs to pktLog if configured.
    try:
        import json as _json, logging as _logging
        import aiosqlite as _aio
        _fwd: dict = {}
        async with _aio.connect(settings.db_path) as _db:
            async with _db.execute(
                "SELECT key, value FROM settings WHERE key LIKE 'log_forward_%'"
            ) as _cur:
                for _k, _v in await _cur.fetchall():
                    try:
                        _fwd[_k] = _json.loads(_v)
                    except Exception:
                        _fwd[_k] = _v
        if _fwd.get("log_forward_enabled"):
            from app.log_forward import configure_forwarding
            configure_forwarding(
                enabled=True,
                host=str(_fwd.get("log_forward_host") or ""),
                port=int(_fwd.get("log_forward_port") or 5514),
                protocol=str(_fwd.get("log_forward_protocol") or "udp"),
                level=getattr(_logging, str(_fwd.get("log_forward_level") or "INFO"), _logging.INFO),
                app_name=str(_fwd.get("log_forward_app_name") or "pktnode"),
            )
    except Exception as _e:
        log.warning(f"Log forwarding setup skipped: {_e}")

    # Run SQLite migrations
    await init_db()
    log.info("Database migrations applied")

    # Seed initial admin user (first boot only; no-op if users already exist)
    await seed_admin()
    log.info("Admin seed check complete")

    # Start alert engine (node_offline / disk_low / cpu_high / mem_high)
    from app.alerts.engine import AlertEngine
    engine = AlertEngine()
    await engine.start(settings.db_path)
    app.state.alert_engine = engine
    log.info("Alert engine started")

    # Start alert event cleanup job
    from app.alerts.cleanup import AlertCleanup
    cleanup = AlertCleanup()
    await cleanup.start()
    log.info("Alert cleanup started")

    # Start backup scheduler
    from app.backup import BackupScheduler
    backup_scheduler = BackupScheduler()
    await backup_scheduler.start()
    log.info("Backup scheduler started")

    # Start enrollment token staleness cleanup
    from app.enrollment_cleanup import EnrollmentCleanup
    enrollment_cleanup = EnrollmentCleanup()
    await enrollment_cleanup.start()
    log.info("Enrollment token cleanup started")

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    log.info("pktNode shutting down")
    await engine.stop()
    await cleanup.stop()
    await backup_scheduler.stop()
    await enrollment_cleanup.stop()
    _log_handler.stop()
    log.info("Shutdown complete")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="pktNode",
    description="RMM — endpoint asset inventory, monitoring, and remote management for the pkt suite",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

# ── Middleware ────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API Routers ───────────────────────────────────────────────────────────────

app.include_router(auth.router,             prefix="/api/auth",         tags=["auth"])
app.include_router(users.router,            prefix="/api/users",        tags=["users"])
app.include_router(nodes_router.router,     prefix="/api/nodes",        tags=["nodes"])
app.include_router(enrollment_router.router, prefix="/api/enrollment",  tags=["enrollment"])
app.include_router(agent_router.router,     prefix="/api/agent",        tags=["agent"])
app.include_router(settings_router.router,  prefix="/api/settings",     tags=["settings"])
app.include_router(system_router.router,    prefix="/api/system",       tags=["system"])
app.include_router(alerts_router.router,    prefix="/api/alerts",       tags=["alerts"])
app.include_router(logs_router.router,      prefix="/api/logs",         tags=["logs"])
app.include_router(suite_router.router,     prefix="/api/suite",        tags=["suite"])
app.include_router(user_api_keys_router.router, prefix="/api/user-api-keys", tags=["user-api-keys"])
app.include_router(ip_info_router.router,   prefix="/api/ip-info",      tags=["ip-info"])
app.include_router(mxtoolbox_router.router, prefix="/api/mxtoolbox",    tags=["mxtoolbox"])
app.include_router(groups_router.router,    prefix="/api/groups",       tags=["groups"])
app.include_router(widgets_router.router,   prefix="/api/widgets",      tags=["widgets"])
app.include_router(docs_router.router,      prefix="/api/docs-content", tags=["docs"])

# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/api/health", tags=["system"])
async def health():
    return {"status": "ok", "version": "0.1.0"}

# ── Serve prebuilt agent binaries (for install-agent.sh/.ps1 to download) ─────
_agent_releases = Path(__file__).parent.parent / "agent-releases"
if _agent_releases.exists():
    app.mount("/agent-releases", StaticFiles(directory=str(_agent_releases)), name="agent-releases")

# ── Serve React frontend (production build) ───────────────────────────────────
_frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=str(_frontend_dist / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(request: Request, full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Normalize-then-prefix-check (CodeQL's own documented pattern for
        # py/path-injection) rather than pathlib's resolve()/is_relative_to,
        # which its Python taint tracker doesn't recognise as a sanitizer.
        _dist_root = os.path.normpath(str(_frontend_dist))
        _candidate = os.path.normpath(os.path.join(_dist_root, full_path))
        if not (_candidate == _dist_root or _candidate.startswith(_dist_root + os.sep)):
            # Path traversal — this handler is unauthenticated and config.yaml
            # sits two levels above dist, so "../../config.yaml" previously
            # returned the JWT signing key and the credential encryption key.
            raise HTTPException(status_code=404, detail="Not found")
        static_file = Path(_candidate)
        if static_file.exists() and static_file.is_file():
            return FileResponse(str(static_file))
        index = _frontend_dist / "index.html"
        response = FileResponse(str(index))
        # pktHub suite-token bootstrap — set sso cookies so React logs in automatically
        _cfg = settings
        _suite_tk = request.headers.get("x-suite-token", "")
        import secrets as _secrets
        if _suite_tk and _cfg.suite_token and _secrets.compare_digest(_suite_tk, _cfg.suite_token):
            from datetime import datetime, timedelta, timezone
            from jose import jwt as _jose_jwt
            from app.dependencies import _SUITE_ROLE_MAP
            _hub_user = request.headers.get("x-suite-user", "hub_user")
            _hub_role = request.headers.get("x-suite-role", "viewer")
            _local_role = _SUITE_ROLE_MAP.get(_hub_role, "viewer")
            _expire = datetime.now(tz=timezone.utc) + timedelta(hours=8)
            _payload = {"sub": "0", "role": _local_role, "exp": _expire, "type": "access"}
            _jwt = _jose_jwt.encode(_payload, _cfg.secret_key, algorithm=_cfg.algorithm)
            response.set_cookie("sso_access_token", _jwt,       max_age=60, httponly=False, samesite="lax")
            response.set_cookie("sso_role",         _local_role, max_age=60, httponly=False, samesite="lax")
        return response


# ── Entrypoint (dev convenience: python -m app.main) ──────────────────────────
# Production uses `python -m app.server` (see pktnode.service) which reads
# host/port from config.yaml without the SSL/DB-probing done here.
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        workers=1,
    )
