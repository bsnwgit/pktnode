"""
pktNode — Widget endpoints for pktHub NOC Builder integration.

Manifest: GET /api/widgets/manifest  → list of widget definitions
Views:    GET /api/widgets/{id}      → server-rendered HTML page (iframe target)
Options:  GET /api/widgets/options/* → JSON [{value,label}] for dynamic param pickers
"""
from __future__ import annotations

import secrets

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import get_settings
from app.api.nodes import _STATUS_EXPR, _status_params

router = APIRouter()
_s     = get_settings()
_DB    = _s.db_path


async def require_suite_token(request: Request) -> None:
    """
    Widget views/options are embedded via pktHub's server-side proxy
    (proxy-display), which always attaches X-Suite-Token — never loaded
    directly by a browser. Require a valid token so the underlying node
    inventory/metrics/alerts data isn't reachable by anyone who can just
    reach the port.
    """
    settings = get_settings()
    token = request.headers.get("x-suite-token", "")
    if not token or not settings.suite_token or not secrets.compare_digest(token, settings.suite_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Valid X-Suite-Token required")

# ── Manifest ──────────────────────────────────────────────────────────────────
MANIFEST = [
    {
        "id": "node_status", "title": "Node Status",
        "description": "All endpoints with derived online/offline/stale status, worst first",
        "view_path": "/api/widgets/node_status",
        "default_w": 640, "default_h": 380, "min_w": 340, "min_h": 220,
    },
    {
        "id": "node_metrics", "title": "Node Metrics",
        "description": "Latest CPU/memory/disk usage for one endpoint",
        "view_path": "/api/widgets/node_metrics",
        "default_w": 460, "default_h": 300, "min_w": 280, "min_h": 180,
        "params": [
            {
                "key": "node_id", "label": "Node", "type": "select",
                "options_path": "/api/widgets/options/nodes",
            }
        ],
    },
    {
        "id": "active_alerts", "title": "Active Alerts",
        "description": "Unresolved endpoint alert events",
        "view_path": "/api/widgets/active_alerts",
        "default_w": 640, "default_h": 360, "min_w": 320, "min_h": 200,
    },
]


@router.get("/manifest")
async def widget_manifest():
    return MANIFEST


# ── Shared page shell ───────────────────────────────────────────────────────────
def _page(title: str, body: str) -> str:
    return f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#0a1628;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;font-size:13px;height:100vh;overflow:hidden;display:flex;flex-direction:column}}
.hdr{{padding:8px 14px;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:8px;flex-shrink:0;height:36px}}
.hdr-dot{{width:6px;height:6px;border-radius:50%;background:#facc15;flex-shrink:0}}
.hdr-title{{font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.03em}}
.content{{flex:1;overflow:auto;padding:12px}}
table{{width:100%;border-collapse:collapse}}
th{{text-align:left;font-size:10px;color:#475569;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding:4px 8px;border-bottom:1px solid #1e293b}}
td{{padding:6px 8px;border-bottom:1px solid #0f172a;font-size:12px;color:#cbd5e1}}
tr:hover td{{background:#111827}}
.badge{{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600}}
.bg{{background:#052e16;color:#4ade80}}.br{{background:#3f1515;color:#f87171}}
.by{{background:#422006;color:#fbbf24}}.bn{{background:#1e293b;color:#64748b}}
.empty{{text-align:center;padding:40px;color:#334155;font-size:12px}}
.tile-row{{display:flex;gap:14px;margin-bottom:14px;flex-wrap:wrap}}
.tile{{flex:1;min-width:100px;background:#111827;border:1px solid #1e293b;border-radius:8px;padding:10px 12px}}
.tile-label{{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px}}
.tile-value{{font-size:22px;font-weight:700;color:#e2e8f0}}
</style>
<script>setTimeout(()=>location.reload(),30000)</script>
</head><body>
<div class="hdr"><div class="hdr-dot"></div><div class="hdr-title">{title}</div></div>
<div class="content">{body}</div>
</body></html>"""


def _status_badge(status: str) -> str:
    s = (status or "").lower()
    if s == "online":
        return '<span class="badge bg">ONLINE</span>'
    if s in ("offline", "stale"):
        return '<span class="badge br">{}</span>'.format(s.upper())
    if s == "pending":
        return '<span class="badge by">PENDING</span>'
    return f'<span class="badge bn">{(status or "UNKNOWN").upper()}</span>'


# ── Node Status widget ────────────────────────────────────────────────────────
@router.get("/node_status", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_node_status():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            params = await _status_params(db)
            async with db.execute(
                f"""SELECT n.id, n.hostname, n.display_name, n.last_checkin_at, {_STATUS_EXPR}
                    FROM nodes n WHERE n.is_active = 1""",
                params,
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception:
        pass

    order = {"stale": 0, "offline": 1, "pending": 2, "online": 3}
    rows.sort(key=lambda r: order.get(r["status"], 4))

    if rows:
        trs = "".join(
            f"<tr><td>{r['display_name'] or r['hostname']}</td>"
            f"<td>{_status_badge(r['status'])}</td>"
            f"<td>{str(r['last_checkin_at'] or '')[:19].replace('T',' ')}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Node</th><th>Status</th><th>Last Check-in</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = '<div class="empty">No nodes</div>'
    return HTMLResponse(_page("Node Status", body))


# ── Node Metrics widget (per-node, dynamic) ──────────────────────────────────
@router.get("/node_metrics", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_node_metrics(node_id: int | None = None):
    if not node_id:
        return HTMLResponse(_page("Node Metrics", '<div class="empty">Select a node</div>'))

    node_name = str(node_id)
    metrics = None
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT hostname, display_name FROM nodes WHERE id=?", (node_id,)
            ) as cur:
                row = await cur.fetchone()
                if row:
                    node_name = row["display_name"] or row["hostname"]
            async with db.execute(
                """SELECT cpu_pct, mem_pct, disk_pct, recorded_at FROM node_metrics_history
                   WHERE node_id=? ORDER BY recorded_at DESC LIMIT 1""",
                (node_id,),
            ) as cur:
                row = await cur.fetchone()
                if row:
                    metrics = dict(row)
    except Exception:
        pass

    def fmt(v):
        return f"{v:.0f}%" if v is not None else "—"

    if metrics:
        body = (
            f'<div style="margin-bottom:8px;color:#64748b;font-size:11px">{node_name}</div>'
            '<div class="tile-row">'
            f'<div class="tile"><div class="tile-label">CPU</div><div class="tile-value">{fmt(metrics.get("cpu_pct"))}</div></div>'
            f'<div class="tile"><div class="tile-label">Memory</div><div class="tile-value">{fmt(metrics.get("mem_pct"))}</div></div>'
            f'<div class="tile"><div class="tile-label">Disk</div><div class="tile-value">{fmt(metrics.get("disk_pct"))}</div></div>'
            "</div>"
        )
    else:
        body = f'<div class="empty">No metrics for {node_name}</div>'
    return HTMLResponse(_page("Node Metrics", body))


# ── Active Alerts widget ──────────────────────────────────────────────────────
@router.get("/active_alerts", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_active_alerts():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """SELECT ae.severity, ae.message, ae.fired_at, n.hostname, n.display_name
                   FROM alert_events ae LEFT JOIN nodes n ON n.id = ae.node_id
                   WHERE ae.resolved_at IS NULL AND ae.acked_at IS NULL
                   ORDER BY ae.fired_at DESC LIMIT 40"""
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception:
        pass

    if rows:
        trs = "".join(
            f'<tr><td><span class="badge {"br" if r["severity"] in ("critical","high") else "by"}">{r["severity"].upper()}</span></td>'
            f"<td>{r.get('display_name') or r.get('hostname') or ''}</td><td>{r['message']}</td>"
            f"<td>{str(r['fired_at'])[:19].replace('T',' ')}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Severity</th><th>Node</th><th>Message</th><th>Fired</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = '<div class="empty">No active alerts</div>'
    return HTMLResponse(_page("Active Alerts", body))


# ── Param option pickers ──────────────────────────────────────────────────────
@router.get("/options/nodes", dependencies=[Depends(require_suite_token)])
async def widget_options_nodes():
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, hostname, display_name FROM nodes WHERE is_active=1 ORDER BY hostname"
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
        return JSONResponse([{"value": str(r["id"]), "label": r["display_name"] or r["hostname"]} for r in rows])
    except Exception:
        return JSONResponse([])
