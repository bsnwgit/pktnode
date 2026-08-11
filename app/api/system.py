"""
System management endpoints — restart, health, cleanup, etc.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import shutil
import signal
import subprocess
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

import re
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import get_settings
from app.dependencies import CurrentUser, require_admin
from app.version import get_version

log = logging.getLogger("pktnode.system")
router = APIRouter()


@router.get("/info")
async def system_info(user: CurrentUser) -> dict:
    """Version/about info shown on the Settings → System tab."""
    cfg = get_settings()
    return {
        "app_name": "pktNode",
        "version": get_version(),
        "install_dir": cfg.install_dir,
        "github": "https://github.com/bsnwgit/pktnode",
        "license": "PolyForm Noncommercial 1.0.0",
        "developer": "Robert Barnett",
        "contact": "inquiry@barsoftnetware.com",
    }


async def _delayed_restart(delay: float = 1.5) -> None:
    """Wait briefly, then exit so systemd restarts the service."""
    await asyncio.sleep(delay)
    os._exit(1)  # non-zero exit triggers systemd Restart=on-failure


def _config_file_path() -> Path:
    """Locate the on-disk config.yaml — same candidates app/config.py checks."""
    cfg = get_settings()
    for candidate in [Path("config.yaml"), Path(cfg.install_dir) / "config.yaml"]:
        if candidate.exists():
            return candidate
    raise HTTPException(500, "config.yaml not found")


@router.post("/cleanup", dependencies=[Depends(require_admin)])
async def run_cleanup() -> dict:
    """
    Manually trigger data retention cleanup: delete alert_events older than
    alert_event_retention_days, and node_metrics_history rows older than 90
    days (metrics history isn't user-configurable retention, just capped so
    the DB doesn't grow unbounded).
    """
    cfg = get_settings()

    retention_alerts = 90
    async with aiosqlite.connect(cfg.db_path) as db:
        async with db.execute(
            "SELECT value FROM settings WHERE key = 'alert_event_retention_days'"
        ) as cur:
            row = await cur.fetchone()
            if row:
                try:
                    retention_alerts = int(json.loads(row[0]))
                except (ValueError, TypeError):
                    pass

    result: dict = {
        "alert_events_deleted": 0,
        "metrics_history_deleted": 0,
        "network_history_deleted": 0,
        "status": "ok",
    }

    try:
        async with aiosqlite.connect(cfg.db_path) as db:
            cur = await db.execute(
                "DELETE FROM alert_events WHERE fired_at < datetime('now', ?)",
                (f"-{retention_alerts} days",),
            )
            result["alert_events_deleted"] = cur.rowcount
            cur2 = await db.execute(
                "DELETE FROM node_metrics_history WHERE recorded_at < datetime('now', '-90 days')"
            )
            result["metrics_history_deleted"] = cur2.rowcount
            cur3 = await db.execute(
                "DELETE FROM node_network_history WHERE recorded_at < datetime('now', '-90 days')"
            )
            result["network_history_deleted"] = cur3.rowcount
            await db.commit()
    except Exception as e:
        log.warning(f"Cleanup error: {e}")
        result["status"] = f"error: {e}"

    log.info(
        f"Manual cleanup: alert_events_deleted={result['alert_events_deleted']}, "
        f"metrics_history_deleted={result['metrics_history_deleted']}, "
        f"network_history_deleted={result['network_history_deleted']}"
    )
    return result


_STORAGE_STATS_TABLES = [
    "nodes", "node_software", "node_processes", "node_interfaces",
    "node_metrics_history", "node_network_history", "node_disks",
    "node_unraid_array", "node_unraid_disks", "node_unraid_containers", "node_unraid_vms",
    "commands", "alert_events", "app_logs",
]


@router.get("/storage-stats", dependencies=[Depends(require_admin)])
async def storage_stats() -> dict:
    """DB file size + row counts per table — SQLite is the only backend
    pktNode has, so this is the closest equivalent to a storage backend
    picker's health view."""
    cfg = get_settings()
    db_path = Path(cfg.db_path)
    size_bytes = db_path.stat().st_size if db_path.exists() else 0

    counts: dict[str, int] = {}
    async with aiosqlite.connect(cfg.db_path) as db:
        for table in _STORAGE_STATS_TABLES:
            async with db.execute(f"SELECT COUNT(*) FROM {table}") as cur:
                row = await cur.fetchone()
                counts[table] = row[0] if row else 0

    return {"db_size_bytes": size_bytes, "row_counts": counts}


class ExportRequest(BaseModel):
    password: str


async def _verify_export_password(user: dict, password: str) -> None:
    """Step-up re-auth for the full backup bundle.

    The bundle deliberately contains both the database and config.yaml,
    because a restore is useless without them — but that pairing means one
    downloaded file holds every encrypted secret AND the key that decrypts
    them, and it lands wherever the browser puts downloads. Being logged in as
    an admin is not a high enough bar to hand that over, so the caller
    re-enters their current password: the same bar as revealing any other
    stored secret.

    Suite-proxied callers (X-Suite-Token, synthetic user id 0) have no local
    password and are always rejected — they must log in as a real local admin.
    """
    from app.auth.local import verify_password

    _settings = get_settings()
    async with aiosqlite.connect(_settings.db_path) as _conn:
        _conn.row_factory = aiosqlite.Row
        async with _conn.execute(
            "SELECT hashed_password FROM users WHERE id = ?", (user["id"],)
        ) as _cur:
            _row = await _cur.fetchone()
    if not _row or not verify_password(password, _row["hashed_password"]):
        raise HTTPException(status_code=401, detail="Incorrect password")


@router.post("/export")
async def export_bundle(body: ExportRequest, user: dict = Depends(require_admin)):
    await _verify_export_password(user, body.password)

    """
    Download a full backup bundle as a .tar.gz archive.
    Includes: SQLite DB (nodes, users, settings, alert rules) + config.yaml.
    Streams directly to avoid holding large data in memory.
    """
    cfg = get_settings()
    date_str = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"pktnode-export-{date_str}.tar.gz"

    def _build_archive(out_path: Path) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)

            # ── SQLite DB ────────────────────────────────────────────────────
            db = Path(cfg.db_path)
            if db.exists():
                shutil.copy2(str(db), str(tmp_path / "pktnode.db"))

            # ── config.yaml ──────────────────────────────────────────────────
            for candidate in [Path("config.yaml"), Path(cfg.install_dir) / "config.yaml"]:
                if candidate.exists():
                    shutil.copy2(str(candidate), str(tmp_path / "config.yaml"))
                    break

            # ── RESTORE.md ───────────────────────────────────────────────────
            ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
            instructions = f"""# pktNode Full Restore Bundle
Generated: {ts}

## Contents
- pktnode.db   — SQLite: nodes, agent tokens, users, settings, alert rules
- config.yaml  — Server startup config (port, JWT secret)

## Restore procedure (fresh install)
1. Deploy pktNode to the new server per the README.
2. Stop the service:     sudo systemctl stop pktnode
3. Copy pktnode.db    →  {cfg.db_path}
4. Copy config.yaml   →  {cfg.install_dir}/config.yaml
5. Start the service:    sudo systemctl start pktnode

## Notes
- The JWT secret in config.yaml will invalidate existing browser sessions —
  users on the old server will need to log in again after restore.
- Existing agents keep working against the new server unchanged as long as
  the DB (and therefore their agent_tokens rows) came along in the restore —
  their bearer token doesn't change.
- If you use the UI restore endpoint, the service will need a manual restart
  after restore for config.yaml changes to take effect.
"""
            (tmp_path / "RESTORE.md").write_text(instructions)

            # ── Bundle into tar.gz ────────────────────────────────────────────
            with tarfile.open(str(out_path), "w:gz") as tar:
                for f in tmp_path.iterdir():
                    tar.add(str(f), arcname=f.name)

    # mkstemp, not mktemp: mktemp only *suggests* a name, leaving a window in
    # which anything can create or symlink that path before we write to it.
    # mkstemp creates it atomically, O_EXCL and mode 0600.
    _fd, _tmp_name = tempfile.mkstemp(suffix=".tar.gz")
    os.close(_fd)
    tmp_out = Path(_tmp_name)
    try:
        await asyncio.to_thread(_build_archive, tmp_out)

        def _iterfile():
            try:
                with open(tmp_out, "rb") as f:
                    while chunk := f.read(65536):
                        yield chunk
            finally:
                tmp_out.unlink(missing_ok=True)

        return StreamingResponse(
            _iterfile(),
            media_type="application/gzip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception:
        tmp_out.unlink(missing_ok=True)
        raise


def _restore_from_dir(src_dir: Path, cfg, files: Optional[set[str]]) -> dict:
    """
    Restore whatever of {pktnode.db, config.yaml} is present in src_dir and
    selected by `files` (None means restore everything present).
    """
    result: dict = {}

    def wanted(name: str) -> bool:
        return files is None or name in files

    db_src = src_dir / "pktnode.db"
    if wanted("pktnode.db"):
        if db_src.exists():
            shutil.copy2(str(db_src), cfg.db_path)
            result["pktnode.db"] = "restored"
        else:
            result["pktnode.db"] = "not found in backup"

    cfg_src = src_dir / "config.yaml"
    if wanted("config.yaml"):
        if cfg_src.exists():
            shutil.copy2(str(cfg_src), str(Path(cfg.install_dir) / "config.yaml"))
            result["config.yaml"] = "restored (restart required)"
        else:
            result["config.yaml"] = "not found in backup"

    return result


def _parse_files_param(files: Optional[str]) -> Optional[set[str]]:
    if not files:
        return None
    return {f.strip() for f in files.split(",") if f.strip()}


@router.post("/import", dependencies=[Depends(require_admin)])
async def import_bundle(file: UploadFile = File(...), files: Optional[str] = Form(None)):
    """
    Restore from a pktnode export bundle (.tar.gz).
    `files` is an optional comma-separated subset of {pktnode.db, config.yaml} —
    omit to restore everything present in the bundle.
    Requires a service restart after restore for config changes to take effect.
    """
    cfg = get_settings()
    data = await file.read()
    wanted = _parse_files_param(files)

    def _do_restore(raw: bytes) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            archive_path = tmp_path / "upload.tar.gz"
            archive_path.write_bytes(raw)

            try:
                with tarfile.open(str(archive_path), "r:gz") as tar:
                    tmp_root = tmp_path.resolve()
                    for member in tar.getmembers():
                        member_path = (tmp_path / member.name).resolve()
                        if not member_path.is_relative_to(tmp_root):
                            return {"error": f"Refusing to extract archive: unsafe path in member '{member.name}'"}
                        if member.issym() or member.islnk():
                            link_target = (tmp_path / member.name).parent.joinpath(member.linkname).resolve()
                            if not link_target.is_relative_to(tmp_root):
                                return {"error": f"Refusing to extract archive: unsafe link target in member '{member.name}'"}
                    tar.extractall(tmp_path)
            except Exception as e:
                return {"error": f"Failed to extract archive: {e}"}

            return _restore_from_dir(tmp_path, cfg, wanted)

    result = await asyncio.to_thread(_do_restore, data)
    return result


@router.post("/backup", dependencies=[Depends(require_admin)])
async def run_backup_now() -> dict:
    """Trigger an immediate backup run regardless of schedule."""
    from app.backup import run_backup_sync
    cfg = get_settings()
    result = await asyncio.to_thread(run_backup_sync, cfg.db_path)
    return result


@router.get("/backup/list", dependencies=[Depends(require_admin)])
async def list_backups() -> list:
    """List existing backup snapshots on the server, newest first."""
    from app.backup import list_backups_sync
    cfg = get_settings()
    return await asyncio.to_thread(list_backups_sync, cfg.db_path)


@router.post("/backup/restore/{snapshot_name}", dependencies=[Depends(require_admin)])
async def restore_from_snapshot(snapshot_name: str, files: Optional[str] = None) -> dict:
    """
    Restore directly from an on-server backup snapshot — no download/upload round trip.
    `files` is an optional comma-separated subset of {pktnode.db, config.yaml} —
    omit to restore everything present in the snapshot.
    """
    from app.backup import _read_backup_settings_sync

    if not re.fullmatch(r"backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}", snapshot_name):
        raise HTTPException(status_code=400, detail="Invalid snapshot name")

    cfg = get_settings()
    s = await asyncio.to_thread(_read_backup_settings_sync, cfg.db_path)
    backup_root = Path(s["backup_path"]).resolve()
    snap_dir = (backup_root / snapshot_name).resolve()
    if snap_dir.parent != backup_root or not snap_dir.is_dir():
        raise HTTPException(status_code=404, detail="Snapshot not found")

    wanted = _parse_files_param(files)
    result = await asyncio.to_thread(_restore_from_dir, snap_dir, cfg, wanted)
    return result


# ── SSL certificate management ─────────────────────────────────────────────────

def _ssl_dir() -> Path:
    return Path(get_settings().ssl_dir)


def _cert_file() -> Path:
    return _ssl_dir() / "server.crt"


def _key_file() -> Path:
    return _ssl_dir() / "server.key"


def _cert_info() -> dict:
    """Read cert metadata via openssl CLI. Returns {} on failure."""
    try:
        proc = subprocess.run(
            ["openssl", "x509", "-in", str(_cert_file()), "-noout",
             "-enddate", "-subject", "-issuer"],
            capture_output=True, text=True, timeout=5,
        )
        if proc.returncode != 0:
            return {"error": proc.stderr.strip()}
        info: dict = {}
        for line in proc.stdout.strip().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip().lower()
                if "notafter" in k or "enddate" in k:
                    info["expires"] = v.strip()
                elif k == "subject":
                    info["subject"] = v.strip()
                elif k == "issuer":
                    info["issuer"] = v.strip()
        try:
            from datetime import datetime, timezone
            exp = datetime.strptime(info["expires"], "%b %d %H:%M:%S %Y %Z").replace(
                tzinfo=timezone.utc
            )
            info["days_until_expiry"] = (exp - datetime.now(timezone.utc)).days
            info["expires_iso"] = exp.isoformat()
        except Exception:
            pass
        return info
    except Exception as e:
        return {"error": str(e)}


@router.get("/ssl/status", dependencies=[Depends(require_admin)])
async def ssl_status() -> dict:
    """Return current SSL certificate status."""
    if not _cert_file().exists() or not _key_file().exists():
        return {"installed": False}
    info = await asyncio.to_thread(_cert_info)
    return {"installed": True, **info}


@router.post("/ssl/upload", dependencies=[Depends(require_admin)])
async def upload_ssl_cert(
    cert: UploadFile = File(...),
    key: UploadFile = File(...),
) -> dict:
    """Upload and install a PEM certificate + private key."""
    cert_data = await cert.read()
    key_data  = await key.read()

    if b"-----BEGIN CERTIFICATE-----" not in cert_data:
        raise HTTPException(400, "Invalid certificate — must be PEM format (-----BEGIN CERTIFICATE-----)")
    if b"PRIVATE KEY-----" not in key_data:
        raise HTTPException(400, "Invalid private key — must be PEM format (-----BEGIN ... PRIVATE KEY-----)")

    def _save():
        _ssl_dir().mkdir(parents=True, exist_ok=True)
        _cert_file().write_bytes(cert_data)
        _cert_file().chmod(0o644)
        _key_file().write_bytes(key_data)
        _key_file().chmod(0o600)

    await asyncio.to_thread(_save)
    log.info("SSL certificate uploaded and installed")
    info = await asyncio.to_thread(_cert_info)
    return {"installed": True, "status": "saved", **info}


@router.delete("/ssl/cert", dependencies=[Depends(require_admin)])
async def delete_ssl_cert() -> dict:
    """Remove the installed SSL certificate and key."""
    _cert_file().unlink(missing_ok=True)
    _key_file().unlink(missing_ok=True)
    log.info("SSL certificate removed")
    return {"installed": False, "status": "removed"}


@router.post("/ssl/upload-pfx", dependencies=[Depends(require_admin)])
async def upload_ssl_pfx(
    pfx: UploadFile = File(...),
    passphrase: str = Form(...),
) -> dict:
    """
    Accept a PKCS#12 (.pfx/.p12) bundle + passphrase.
    Extracts the cert and private key as unencrypted PEM files
    (server.crt / server.key) so Uvicorn can load them without interaction.
    """
    pfx_data = await pfx.read()

    def _extract() -> tuple[bool, str]:
        import tempfile
        _ssl_dir().mkdir(parents=True, exist_ok=True)
        # This file holds PKCS#12 private key material, so a predictable name
        # is the worst case for mktemp's create-between-name-and-write window.
        # mkstemp creates it atomically with mode 0600 and hands back the fd.
        _fd, _tmp_name = tempfile.mkstemp(suffix=".pfx")
        with os.fdopen(_fd, "wb") as _fh:
            _fh.write(pfx_data)
        tmp = Path(_tmp_name)
        try:
            cert_proc = subprocess.run(
                ["openssl", "pkcs12",
                 "-in", str(tmp),
                 "-clcerts", "-nokeys",
                 "-passin", f"pass:{passphrase}",
                 "-out", str(_cert_file())],
                capture_output=True, text=True, timeout=15,
            )
            if cert_proc.returncode != 0:
                err = cert_proc.stderr.strip()
                return False, f"Cert extraction failed: {err}"

            key_proc = subprocess.run(
                ["openssl", "pkcs12",
                 "-in", str(tmp),
                 "-nocerts", "-nodes",
                 "-passin", f"pass:{passphrase}",
                 "-out", str(_key_file())],
                capture_output=True, text=True, timeout=15,
            )
            if key_proc.returncode != 0:
                err = key_proc.stderr.strip()
                return False, f"Key extraction failed: {err}"

            _cert_file().chmod(0o644)
            _key_file().chmod(0o600)
            return True, "ok"
        finally:
            tmp.unlink(missing_ok=True)

    ok, msg = await asyncio.to_thread(_extract)
    if not ok:
        raise HTTPException(400, msg)

    log.info("SSL certificate installed from PFX")
    info = await asyncio.to_thread(_cert_info)
    return {"installed": True, "status": "saved", **info}


@router.post("/restart", dependencies=[Depends(require_admin)])
async def restart_service() -> dict:
    """
    Restart the pktNode service.  Response is sent immediately; the
    service process exits ~1.5 s later and systemd brings it back up.
    Requires admin role.
    """
    log.warning("Service restart requested via API")
    asyncio.create_task(_delayed_restart())
    return {"status": "restarting", "message": "Service will restart in ~2 seconds"}


class PortUpdate(BaseModel):
    port: int


@router.get("/port", dependencies=[Depends(require_admin)])
async def get_port() -> dict:
    """
    The port pktNode listens on. Lives in config.yaml (startup config, read
    before the DB connects) rather than the SQLite-backed settings table —
    see app/config.py.
    """
    return {"port": get_settings().port}


@router.post("/port", dependencies=[Depends(require_admin)])
async def set_port(body: PortUpdate) -> dict:
    """
    Update the listen port in config.yaml. Takes effect on the next service
    restart — this only writes the file, it doesn't restart anything itself.
    """
    if not (1 <= body.port <= 65535):
        raise HTTPException(400, "Port must be between 1 and 65535")

    path = _config_file_path()
    text = path.read_text()
    new_line = f"port: {body.port}"
    if re.search(r"(?m)^port:\s*\d+", text):
        text = re.sub(r"(?m)^port:\s*\d+", new_line, text, count=1)
    else:
        text = text.rstrip("\n") + f"\n{new_line}\n"
    path.write_text(text)

    log.warning(f"Listen port changed to {body.port} in config.yaml — restart required to take effect")
    return {"port": body.port, "message": "Saved — restart the service to apply"}

# ── App log forwarding ────────────────────────────────────────────────────────

class LogForwardTest(BaseModel):
    host: str
    port: int = 5514
    protocol: str = "udp"


@router.get("/log-forward/status", dependencies=[Depends(require_admin)])
async def log_forward_status():
    """Delivery counters for the log forwarder, so it can be seen working."""
    from app.log_forward import get_forward_stats
    return get_forward_stats()


@router.post("/log-forward/test", dependencies=[Depends(require_admin)])
async def log_forward_test(body: LogForwardTest):
    """Send one test line to the collector without touching the live handler."""
    from app.log_forward import send_test_message
    return send_test_message(host=body.host, port=body.port, protocol=body.protocol)


@router.post("/log-forward/reload", dependencies=[Depends(require_admin)])
async def log_forward_reload():
    """Re-read log_forward_* settings and apply them without a restart."""
    import json as _json, logging as _logging
    import aiosqlite as _aio
    from app.config import get_settings as _gs
    from app.log_forward import configure_forwarding, get_forward_stats

    cfg = _gs()
    fwd: dict = {}
    async with _aio.connect(cfg.db_path) as db:
        async with db.execute(
            "SELECT key, value FROM settings WHERE key LIKE 'log_forward_%'"
        ) as cur:
            for k, v in await cur.fetchall():
                try:
                    fwd[k] = _json.loads(v)
                except Exception:
                    fwd[k] = v

    configure_forwarding(
        enabled=bool(fwd.get("log_forward_enabled")),
        host=str(fwd.get("log_forward_host") or ""),
        port=int(fwd.get("log_forward_port") or 5514),
        protocol=str(fwd.get("log_forward_protocol") or "udp"),
        level=getattr(_logging, str(fwd.get("log_forward_level") or "INFO"), _logging.INFO),
        app_name=str(fwd.get("log_forward_app_name") or "pktnode"),
    )
    return get_forward_stats()
