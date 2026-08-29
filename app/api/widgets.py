"""
pktNode — Widget endpoints for pktHub NOC Builder integration.

Manifest: GET /api/widgets/manifest  → list of widget definitions
Views:    GET /api/widgets/{id}      → server-rendered HTML page (iframe target)
Options:  GET /api/widgets/options/* → JSON [{value,label}] for dynamic param pickers
"""
from __future__ import annotations

import html
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import get_settings
from app.dependencies import require_suite_token
from app.api.nodes import _STATUS_EXPR, _status_params

# These views are embedded as unauthenticated iframes by pktHub's NOC Builder,
# so they can't require a login session — but they do render internal node and
# alert data, so every route on this router requires a valid X-Suite-Token
# (the trusted-proxy secret pktHub already sends on every proxied request).
# ── Refresh interval ──────────────────────────────────────────────────────────
# pktHub's Settings → NOC → "Widget refresh" governs how often a tile reloads
# itself. It arrives as ?refresh=<seconds> on the widget URL; captured here as a
# router dependency so the ~150 view functions need no signature change.
_REFRESH: ContextVar = ContextVar("widget_refresh", default=30)


async def _capture_refresh(request: Request) -> None:
    raw = request.query_params.get("refresh")
    try:
        _REFRESH.set(max(5, min(int(raw), 3600)) if raw else 30)
    except (TypeError, ValueError):
        _REFRESH.set(30)


router = APIRouter(dependencies=[Depends(_capture_refresh), Depends(require_suite_token)])
_s     = get_settings()
_DB    = _s.db_path


# ── Manifest ──────────────────────────────────────────────────────────────────
# `category` groups these in pktHub's NOC library picker. Every data surface the
# app renders in its own UI should have an entry here — the NOC builder can only
# offer what this list declares.
_NODE_PARAM = {
    "key": "node_id", "label": "Node", "type": "select",
    "options_path": "/api/widgets/options/nodes",
}
_WINDOW_PARAM = {
    "key": "hours", "label": "Window", "type": "select",
    "options": [{"value": "1", "label": "1 hour"}, {"value": "6", "label": "6 hours"},
                {"value": "24", "label": "24 hours"}, {"value": "168", "label": "7 days"}],
}

MANIFEST = [
    # ── Overview ──────────────────────────────────────────────────────────────
    {
        "id": "node_summary", "title": "Node Summary", "category": "Overview",
        "description": "Endpoint counts by derived status across the fleet",
        "view_path": "/api/widgets/node_summary",
        "default_w": 560, "default_h": 200, "min_w": 300, "min_h": 150,
    },
    {
        "id": "alert_summary", "title": "Alert Summary", "category": "Overview",
        "description": "Active alert counts by severity",
        "view_path": "/api/widgets/alert_summary",
        "default_w": 420, "default_h": 200, "min_w": 260, "min_h": 150,
    },
    {
        "id": "nodes_by_os", "title": "Nodes by OS", "category": "Overview",
        "description": "Endpoint distribution across operating systems",
        "view_path": "/api/widgets/nodes_by_os",
        "default_w": 440, "default_h": 280, "min_w": 260, "min_h": 170,
    },
    {
        "id": "fleet_resources", "title": "Fleet Resources", "category": "Overview",
        "description": "Average CPU, memory and disk pressure across reporting nodes",
        "view_path": "/api/widgets/fleet_resources",
        "default_w": 480, "default_h": 200, "min_w": 280, "min_h": 150,
    },

    # ── Nodes ─────────────────────────────────────────────────────────────────
    {
        "id": "node_status", "title": "Node Status", "category": "Nodes",
        "description": "All endpoints with derived online/offline/stale status, worst first",
        "view_path": "/api/widgets/node_status",
        "default_w": 640, "default_h": 380, "min_w": 340, "min_h": 220,
    },
    {
        "id": "node_metrics", "title": "Node Metrics", "category": "Nodes",
        "description": "Latest CPU/memory/disk usage for one endpoint",
        "view_path": "/api/widgets/node_metrics",
        "default_w": 460, "default_h": 300, "min_w": 280, "min_h": 180,
        "params": [_NODE_PARAM],
    },
    {
        "id": "node_inventory", "title": "Node Inventory", "category": "Nodes",
        "description": "Hardware and OS detail per endpoint",
        "view_path": "/api/widgets/node_inventory",
        "default_w": 800, "default_h": 400, "min_w": 380, "min_h": 220,
    },
    {
        "id": "node_uptime", "title": "Node Uptime", "category": "Nodes",
        "description": "Reported uptime per endpoint, least stable first",
        "view_path": "/api/widgets/node_uptime",
        "default_w": 540, "default_h": 340, "min_w": 300, "min_h": 200,
    },

    # ── Resources ─────────────────────────────────────────────────────────────
    {
        "id": "top_cpu", "title": "Top CPU", "category": "Resources",
        "description": "Endpoints with the highest current CPU usage",
        "view_path": "/api/widgets/top_cpu",
        "default_w": 520, "default_h": 340, "min_w": 280, "min_h": 200,
    },
    {
        "id": "top_memory", "title": "Top Memory", "category": "Resources",
        "description": "Endpoints with the highest current memory usage",
        "view_path": "/api/widgets/top_memory",
        "default_w": 520, "default_h": 340, "min_w": 280, "min_h": 200,
    },
    {
        "id": "disk_pressure", "title": "Disk Pressure", "category": "Resources",
        "description": "Fullest volumes across the fleet",
        "view_path": "/api/widgets/disk_pressure",
        "default_w": 620, "default_h": 360, "min_w": 320, "min_h": 200,
    },

    # ── Trends (charts) ───────────────────────────────────────────────────────
    {
        "id": "node_metric_trend", "title": "Node Metric Trend", "category": "Trends",
        "description": "CPU, memory and disk over time for one endpoint",
        "view_path": "/api/widgets/node_metric_trend",
        "default_w": 680, "default_h": 320, "min_w": 320, "min_h": 180,
        "params": [_NODE_PARAM, _WINDOW_PARAM],
    },
    {
        "id": "network_trend", "title": "Network Trend", "category": "Trends",
        "description": "Sent and received throughput over time for one endpoint",
        "view_path": "/api/widgets/network_trend",
        "default_w": 680, "default_h": 320, "min_w": 320, "min_h": 180,
        "params": [_NODE_PARAM, _WINDOW_PARAM],
    },
    {
        "id": "speedtest_trend", "title": "Speedtest Trend", "category": "Trends",
        "description": "Download, upload and latency across recent speedtests",
        "view_path": "/api/widgets/speedtest_trend",
        "default_w": 680, "default_h": 320, "min_w": 320, "min_h": 180,
        "params": [_NODE_PARAM],
    },

    # ── Alerts ────────────────────────────────────────────────────────────────
    {
        "id": "active_alerts", "title": "Active Alerts", "category": "Alerts",
        "description": "Unresolved endpoint alert events",
        "view_path": "/api/widgets/active_alerts",
        "default_w": 640, "default_h": 360, "min_w": 320, "min_h": 200,
    },

    # ── Unraid ────────────────────────────────────────────────────────────────
    {
        "id": "unraid_array", "title": "Unraid Array", "category": "Unraid",
        "description": "Array state, parity check progress and disk health",
        "view_path": "/api/widgets/unraid_array",
        "default_w": 700, "default_h": 380, "min_w": 340, "min_h": 220,
    },
    {
        "id": "unraid_containers", "title": "Unraid Containers", "category": "Unraid",
        "description": "Docker container state across Unraid hosts",
        "view_path": "/api/widgets/unraid_containers",
        "default_w": 640, "default_h": 360, "min_w": 320, "min_h": 200,
    },
    {
        "id": "unraid_vms", "title": "Unraid VMs", "category": "Unraid",
        "description": "Virtual machine state across Unraid hosts",
        "view_path": "/api/widgets/unraid_vms",
        "default_w": 560, "default_h": 320, "min_w": 300, "min_h": 180,
    },
]


@router.get("/manifest")
async def widget_manifest():
    return MANIFEST



# ── Widget states ──────────────────────────────────────────────────────────────
# A blank tile on a wallboard reads as "all quiet", so the three reasons a widget
# can show nothing must look different from each other:
#   empty — the query ran and there genuinely is nothing
#   cfg   — the widget needs a param chosen in the NOC editor before it can run
#   err   — the query failed; this must never be mistaken for "nothing to report"
# Query helpers record failures here rather than swallowing them; _page() renders
# the error state instead of whatever half-built body the caller produced. The
# ContextVar is per-request: each request runs in its own task context.
_WIDGET_ERR: ContextVar = ContextVar("widget_err", default=None)


def _note_err(exc: BaseException) -> None:
    _WIDGET_ERR.set(f"{type(exc).__name__}: {exc}"[:200])


def _state(kind: str, msg: str, sub: str = "") -> str:
    icon = {"empty": "○", "cfg": "⚙", "err": "⚠"}.get(kind, "○")
    sub_html = f'<div class="state-sub">{html.escape(str(sub))}</div>' if sub else ""
    return (f'<div class="state state-{kind}"><div class="state-icon">{icon}</div>'
            f'<div class="state-msg">{html.escape(str(msg))}</div>{sub_html}</div>')


def _empty(msg: str) -> str:
    return _state("empty", msg)


def _needs(msg: str) -> str:
    """The widget is fine — it is waiting on a filter the NOC editor must set."""
    return _state("cfg", msg, "Select it in the widget's Filters panel")


# ── Shared page shell ───────────────────────────────────────────────────────────
def _page(title: str, body: str) -> str:
    # Widget titles carry device/metric/subnet names chosen in the NOC editor
    # and read back from device data, and these pages render on an
    # unauthenticated display URL — escape before interpolating.
    title = html.escape(str(title))
    # A failed query leaves a body saying "nothing here" — which is a lie.
    _err = _WIDGET_ERR.get()
    if _err:
        body = _state("err", "Widget unavailable", _err)
    return f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#04060a;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;font-size:13px;height:100vh;overflow:hidden;display:flex;flex-direction:column}}
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
.bar-row{{display:flex;align-items:center;gap:8px;margin-bottom:8px}}
.bar-lbl{{font-size:11px;color:#94a3b8;width:130px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.bar-trk{{flex:1;background:#1e293b;border-radius:3px;height:8px;overflow:hidden}}
.bar-fill{{height:8px;border-radius:3px;background:#facc15}}
.bar-val{{font-size:10px;color:#475569;width:62px;text-align:right;flex-shrink:0}}
.chart-wrap{{width:100%;height:100%;min-height:90px;display:flex;flex-direction:column}}
.chart-meta{{display:flex;gap:12px;font-size:10px;color:#475569;margin-bottom:6px;flex-wrap:wrap}}
.chart-meta b{{color:#94a3b8;font-weight:600}}
.chart-svg{{flex:1;width:100%;min-height:0}}
.legend{{display:flex;gap:12px;font-size:10px;color:#94a3b8;margin-top:6px;flex-wrap:wrap}}
.legend i{{width:8px;height:2px;display:inline-block;margin-right:4px;vertical-align:middle}}
.state{{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:80px;text-align:center;padding:18px;gap:5px}}
.state-icon{{font-size:17px;line-height:1;opacity:0.85}}
.state-msg{{font-size:12px;font-weight:500}}
.state-sub{{font-size:10px;color:#64748b;max-width:92%;word-break:break-word}}
.state-empty{{color:#64748b}}
.state-cfg{{color:#fbbf24}}
.state-err{{color:#f87171}}
</style>
<script>setTimeout(()=>location.reload(),{_REFRESH.get() * 1000})</script>
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
    return f'<span class="badge bn">{html.escape((status or "UNKNOWN").upper())}</span>'


# ── Query helper ────────────────────────────────────────────────────────────────
async def _rows(sql: str, params: tuple = ()) -> list[dict]:
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(sql, params) as cur:
                return [dict(r) for r in await cur.fetchall()]
    except Exception as exc:
        _note_err(exc)
        return []


# ── Time window ─────────────────────────────────────────────────────────────────
def _since(hours: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")


# ── Node lookup ─────────────────────────────────────────────────────────────────
async def _node_name(node_id: int) -> str | None:
    """None when the node is gone. A NOC screen outlives the fleet it was built
    against, so a widget pinned to a decommissioned endpoint has to say so rather
    than render an empty frame the wall-watcher reads as 'all quiet'."""
    rows = await _rows("SELECT hostname, display_name FROM nodes WHERE id=?", (node_id,))
    if not rows:
        return None
    return rows[0]["display_name"] or rows[0]["hostname"]


def _gone(what: str) -> str:
    return f_empty('{html.escape(what)} no longer exists')


# ── Formatting ──────────────────────────────────────────────────────────────────
def _fmt_n(n) -> str:
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        return "—"
    for div, suf in ((1_000_000_000, "G"), (1_000_000, "M"), (1_000, "K")):
        if abs(n) >= div:
            return f"{n / div:.1f}{suf}"
    return f"{n:.0f}" if n == int(n) else f"{n:.1f}"


def _fmt_pct(v) -> str:
    return f"{float(v):.0f}%" if v is not None else "—"


def _fmt_ts(ts) -> str:
    return str(ts)[:19].replace("T", " ") if ts else "—"


def _fmt_uptime(seconds) -> str:
    try:
        secs = int(seconds or 0)
    except (TypeError, ValueError):
        return "—"
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    return f"{d}d {h}h" if d else f"{h}h {rem // 60}m"


# ── Tiles / bars ────────────────────────────────────────────────────────────────
def _tiles(pairs) -> str:
    return '<div class="tile-row">' + "".join(
        f'<div class="tile"><div class="tile-label">{html.escape(str(label))}</div>'
        f'<div class="tile-value">{html.escape(str(value))}</div></div>'
        for label, value in pairs
    ) + "</div>"


def _bars(rows, color: str = "#facc15") -> str:
    """rows = [(label, numeric_value, display_value)] — scaled to the largest."""
    peak = max((r[1] or 0) for r in rows) if rows else 0
    return "".join(
        f'<div class="bar-row"><div class="bar-lbl" title="{html.escape(str(lbl))}">{html.escape(str(lbl))}</div>'
        f'<div class="bar-trk"><div class="bar-fill" style="width:{(val / peak * 100) if peak else 0:.1f}%;background:{color}"></div></div>'
        f'<div class="bar-val">{html.escape(str(disp))}</div></div>'
        for lbl, val, disp in rows
    )


# ── Inline SVG line chart ───────────────────────────────────────────────────────
# Server-rendered so the iframe stays dependency-free — pktNode ships no charting
# library to these views, and the NOC display must render without network access
# to anything but this app.
_SERIES_COLORS = ("#facc15", "#60a5fa", "#4ade80", "#f87171", "#a78bfa")


def _line_chart(series, fmt=_fmt_n, height: int = 120) -> str:
    """series = [(label, [float, ...])] — equal-length samples, oldest first."""
    series = [(lbl, [v for v in vals if v is not None]) for lbl, vals in series]
    series = [(lbl, vals) for lbl, vals in series if len(vals) >= 2]
    if not series:
        return _empty('No samples in window')

    W, H, PAD = 600, height, 4
    lo = min(min(v) for _, v in series)
    hi = max(max(v) for _, v in series)
    span = (hi - lo) or 1.0

    def _y(v: float) -> float:
        return PAD + (H - 2 * PAD) * (1 - (v - lo) / span)

    paths, legend = [], []
    for i, (lbl, vals) in enumerate(series):
        color = _SERIES_COLORS[i % len(_SERIES_COLORS)]
        step  = W / (len(vals) - 1)
        pts   = [(j * step, _y(v)) for j, v in enumerate(vals)]
        line  = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        area  = f"{line} L{W:.1f},{H} L0,{H} Z"
        paths.append(
            f'<path d="{area}" fill="{color}" opacity="0.10"/>'
            f'<path d="{line}" fill="none" stroke="{color}" stroke-width="1.5" '
            f'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
        )
        legend.append(
            f'<span><i style="background:{color}"></i>{html.escape(str(lbl))} '
            f'<b>{html.escape(fmt(vals[-1]))}</b></span>'
        )

    meta = (f'<div class="chart-meta"><span>min <b>{html.escape(fmt(lo))}</b></span>'
            f'<span>max <b>{html.escape(fmt(hi))}</b></span>'
            f'<span>samples <b>{max(len(v) for _, v in series)}</b></span></div>')
    return (
        f'<div class="chart-wrap">{meta}'
        f'<svg class="chart-svg" viewBox="0 0 {W} {H}" preserveAspectRatio="none" '
        f'xmlns="http://www.w3.org/2000/svg">{"".join(paths)}</svg>'
        f'<div class="legend">{"".join(legend)}</div></div>'
    )


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
    except Exception as exc:
        _note_err(exc)

    order = {"stale": 0, "offline": 1, "pending": 2, "online": 3}
    rows.sort(key=lambda r: order.get(r["status"], 4))

    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r['display_name'] or r['hostname']))}</td>"
            f"<td>{_status_badge(r['status'])}</td>"
            f"<td>{html.escape(str(r['last_checkin_at'] or '')[:19].replace('T',' '))}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Node</th><th>Status</th><th>Last Check-in</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = _empty('No active endpoints enrolled')
    return HTMLResponse(_page("Node Status", body))


# ── Node Metrics widget (per-node, dynamic) ──────────────────────────────────
@router.get("/node_metrics", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_node_metrics(node_id: int | None = None):
    if not node_id:
        return HTMLResponse(_page("Node Metrics", _needs('Select a node')))

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
    except Exception as exc:
        _note_err(exc)

    def fmt(v):
        return f"{v:.0f}%" if v is not None else "—"

    if metrics:
        body = (
            f'<div style="margin-bottom:8px;color:#64748b;font-size:11px">{html.escape(str(node_name))}</div>'
            '<div class="tile-row">'
            f'<div class="tile"><div class="tile-label">CPU</div><div class="tile-value">{fmt(metrics.get("cpu_pct"))}</div></div>'
            f'<div class="tile"><div class="tile-label">Memory</div><div class="tile-value">{fmt(metrics.get("mem_pct"))}</div></div>'
            f'<div class="tile"><div class="tile-label">Disk</div><div class="tile-value">{fmt(metrics.get("disk_pct"))}</div></div>'
            "</div>"
        )
    else:
        body = f_empty('No metrics for {html.escape(str(node_name))}')
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
    except Exception as exc:
        _note_err(exc)

    if rows:
        trs = "".join(
            f'<tr><td><span class="badge {"br" if r["severity"] in ("critical","high") else "by"}">{html.escape(str(r["severity"]).upper())}</span></td>'
            f"<td>{html.escape(str(r.get('display_name') or r.get('hostname') or ''))}</td>"
            f"<td>{html.escape(str(r['message']))}</td>"
            f"<td>{html.escape(str(r['fired_at'])[:19].replace('T',' '))}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Severity</th><th>Node</th><th>Message</th><th>Fired</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = _empty('No active alerts')
    return HTMLResponse(_page("Active Alerts", body))


# ── Node Summary widget ───────────────────────────────────────────────────────
@router.get("/node_summary", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_node_summary():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            params = await _status_params(db)
            async with db.execute(
                f"SELECT {_STATUS_EXPR} FROM nodes n WHERE n.is_active = 1", params
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception as exc:
        _note_err(exc)

    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    body = _tiles([
        ("Nodes",   len(rows)),
        ("Online",  counts.get("online", 0)),
        ("Offline", counts.get("offline", 0)),
        ("Stale",   counts.get("stale", 0)),
        ("Pending", counts.get("pending", 0)),
    ])
    return HTMLResponse(_page("Node Summary", body))


# ── Alert Summary widget ──────────────────────────────────────────────────────
@router.get("/alert_summary", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_alert_summary():
    rows   = await _rows(
        "SELECT LOWER(severity) AS sev, COUNT(*) AS n FROM alert_events "
        "WHERE resolved_at IS NULL AND acked_at IS NULL GROUP BY sev"
    )
    counts = {r["sev"]: r["n"] for r in rows}
    body   = _tiles([
        ("Active",   sum(counts.values())),
        ("Critical", counts.get("critical", 0)),
        ("High",     counts.get("high", 0)),
        ("Warning",  counts.get("warning", 0)),
        ("Info",     counts.get("info", 0)),
    ])
    return HTMLResponse(_page("Alert Summary", body))


# ── Nodes by OS widget ────────────────────────────────────────────────────────
@router.get("/nodes_by_os", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_nodes_by_os():
    rows = await _rows(
        "SELECT COALESCE(NULLIF(os_type,''),'unknown') AS os, COUNT(*) AS n "
        "FROM nodes WHERE is_active=1 GROUP BY os ORDER BY n DESC"
    )
    body = _bars([(r["os"], r["n"], str(r["n"])) for r in rows]) \
        if rows else _empty('No active endpoints enrolled')
    return HTMLResponse(_page("Nodes by OS", body))


# ── Fleet Resources widget ────────────────────────────────────────────────────
@router.get("/fleet_resources", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_fleet_resources():
    # Latest sample per node, then averaged — a node reporting more often must
    # not weigh more heavily than one reporting rarely.
    rows = await _rows(
        """SELECT AVG(cpu_pct) AS cpu, AVG(mem_pct) AS mem, AVG(disk_pct) AS disk, COUNT(*) AS n
           FROM (SELECT h.cpu_pct, h.mem_pct, h.disk_pct
                 FROM node_metrics_history h
                 JOIN (SELECT node_id, MAX(recorded_at) AS mx
                       FROM node_metrics_history GROUP BY node_id) l
                   ON l.node_id = h.node_id AND l.mx = h.recorded_at)"""
    )
    r = rows[0] if rows else {}
    body = _tiles([
        ("Reporting", r.get("n") or 0),
        ("Avg CPU",   _fmt_pct(r.get("cpu"))),
        ("Avg Memory", _fmt_pct(r.get("mem"))),
        ("Avg Disk",  _fmt_pct(r.get("disk"))),
    ])
    return HTMLResponse(_page("Fleet Resources", body))


# ── Node Inventory widget ─────────────────────────────────────────────────────
@router.get("/node_inventory", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_node_inventory():
    rows = await _rows(
        """SELECT hostname, display_name, os_type, os_version, arch, model,
                  cpu_cores, memory_total_mb, disk_total_gb, agent_version
           FROM nodes WHERE is_active=1 ORDER BY hostname LIMIT 60"""
    )
    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r['display_name'] or r['hostname']))}</td>"
            f"<td>{html.escape(str(r.get('os_type') or ''))} {html.escape(str(r.get('os_version') or ''))}</td>"
            f"<td>{html.escape(str(r.get('arch') or ''))}</td>"
            f"<td>{html.escape(str(r.get('model') or ''))}</td>"
            f"<td>{r.get('cpu_cores') or '—'}</td>"
            f"<td>{(str(round((r['memory_total_mb'] or 0) / 1024)) + ' GB') if r.get('memory_total_mb') else '—'}</td>"
            f"<td>{(str(round(r['disk_total_gb'])) + ' GB') if r.get('disk_total_gb') else '—'}</td></tr>"
            for r in rows
        )
        body = ("<table><thead><tr><th>Node</th><th>OS</th><th>Arch</th><th>Model</th>"
                "<th>Cores</th><th>RAM</th><th>Disk</th></tr></thead>"
                f"<tbody>{trs}</tbody></table>")
    else:
        body = _empty('No active endpoints enrolled')
    return HTMLResponse(_page("Node Inventory", body))


# ── Node Uptime widget ────────────────────────────────────────────────────────
@router.get("/node_uptime", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_node_uptime():
    rows = await _rows(
        """SELECT hostname, display_name, uptime_seconds FROM nodes
           WHERE is_active=1 AND uptime_seconds IS NOT NULL
           ORDER BY uptime_seconds ASC LIMIT 30"""
    )
    body = _bars([
        (r["display_name"] or r["hostname"], float(r["uptime_seconds"] or 0), _fmt_uptime(r["uptime_seconds"]))
        for r in rows
    ], color="#60a5fa") if rows else _empty('No endpoint is reporting uptime')
    return HTMLResponse(_page("Node Uptime", body))


# ── Top CPU / Top Memory widgets ──────────────────────────────────────────────
async def _latest_metric_bars(column: str, title: str, color: str) -> str:
    rows = await _rows(
        f"""SELECT n.hostname, n.display_name, h.{column} AS v
            FROM node_metrics_history h
            JOIN (SELECT node_id, MAX(recorded_at) AS mx
                  FROM node_metrics_history GROUP BY node_id) l
              ON l.node_id = h.node_id AND l.mx = h.recorded_at
            JOIN nodes n ON n.id = h.node_id
            WHERE n.is_active = 1 AND h.{column} IS NOT NULL
            ORDER BY h.{column} DESC LIMIT 25"""
    )
    if not rows:
        return f_empty('No {title.lower()} data')
    return _bars(
        [(r["display_name"] or r["hostname"], float(r["v"]), _fmt_pct(r["v"])) for r in rows],
        color=color,
    )


@router.get("/top_cpu", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_top_cpu():
    return HTMLResponse(_page("Top CPU", await _latest_metric_bars("cpu_pct", "CPU", "#facc15")))


@router.get("/top_memory", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_top_memory():
    return HTMLResponse(_page("Top Memory", await _latest_metric_bars("mem_pct", "memory", "#a78bfa")))


# ── Disk Pressure widget ──────────────────────────────────────────────────────
@router.get("/disk_pressure", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_disk_pressure():
    rows = await _rows(
        """SELECT n.hostname, n.display_name, d.mount_point, d.used_pct, d.free_gb, d.total_gb
           FROM node_disks d JOIN nodes n ON n.id = d.node_id
           WHERE n.is_active = 1 AND d.used_pct IS NOT NULL
           ORDER BY d.used_pct DESC LIMIT 30"""
    )
    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r['display_name'] or r['hostname']))}</td>"
            f"<td>{html.escape(str(r['mount_point']))}</td>"
            f"<td>{_fmt_pct(r['used_pct'])}</td>"
            f"<td>{_fmt_n(r['free_gb'])} GB</td>"
            f"<td>{_fmt_n(r['total_gb'])} GB</td></tr>"
            for r in rows
        )
        body = ("<table><thead><tr><th>Node</th><th>Mount</th><th>Used</th>"
                "<th>Free</th><th>Total</th></tr></thead>"
                f"<tbody>{trs}</tbody></table>")
    else:
        body = _empty('No endpoint is reporting disk usage')
    return HTMLResponse(_page("Disk Pressure", body))


# ── Node Metric Trend widget (chart) ──────────────────────────────────────────
@router.get("/node_metric_trend", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_node_metric_trend(node_id: int | None = None, hours: int = 6):
    if not node_id:
        return HTMLResponse(_page("Node Metric Trend", _needs('Select a node')))
    name = await _node_name(node_id)
    if name is None:
        return HTMLResponse(_page("Node Metric Trend", _gone(f"Node {node_id}")))

    hours = max(1, min(int(hours or 6), 720))
    rows  = await _rows(
        """SELECT cpu_pct, mem_pct, disk_pct FROM node_metrics_history
           WHERE node_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC LIMIT 2000""",
        (node_id, _since(hours)),
    )
    body = _line_chart([
        ("CPU",    [r["cpu_pct"]  for r in rows]),
        ("Memory", [r["mem_pct"]  for r in rows]),
        ("Disk",   [r["disk_pct"] for r in rows]),
    ], fmt=_fmt_pct)
    return HTMLResponse(_page(f"{name} — last {hours}h", body))


# ── Network Trend widget (chart) ──────────────────────────────────────────────
@router.get("/network_trend", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_network_trend(node_id: int | None = None, hours: int = 6):
    if not node_id:
        return HTMLResponse(_page("Network Trend", _needs('Select a node')))
    name = await _node_name(node_id)
    if name is None:
        return HTMLResponse(_page("Network Trend", _gone(f"Node {node_id}")))

    hours = max(1, min(int(hours or 6), 720))
    rows  = await _rows(
        """SELECT sent_mbps, recv_mbps FROM node_network_history
           WHERE node_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC LIMIT 2000""",
        (node_id, _since(hours)),
    )
    body = _line_chart([
        ("Sent", [r["sent_mbps"] for r in rows]),
        ("Recv", [r["recv_mbps"] for r in rows]),
    ], fmt=lambda v: f"{float(v):.1f} Mbps")
    return HTMLResponse(_page(f"{name} network — last {hours}h", body))


# ── Speedtest Trend widget (chart) ────────────────────────────────────────────
@router.get("/speedtest_trend", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_speedtest_trend(node_id: int | None = None):
    if not node_id:
        return HTMLResponse(_page("Speedtest Trend", _needs('Select a node')))
    name = await _node_name(node_id)
    if name is None:
        return HTMLResponse(_page("Speedtest Trend", _gone(f"Node {node_id}")))

    # Newest-first from the index, then reversed — charts read oldest to newest.
    rows = await _rows(
        """SELECT download_mbps, upload_mbps, latency_ms FROM speedtest_results
           WHERE node_id = ? AND status = 'completed'
           ORDER BY created_at DESC LIMIT 60""",
        (node_id,),
    )
    rows.reverse()
    body = _line_chart([
        ("Download", [r["download_mbps"] for r in rows]),
        ("Upload",   [r["upload_mbps"]   for r in rows]),
        ("Latency",  [r["latency_ms"]    for r in rows]),
    ])
    return HTMLResponse(_page(f"{name} speedtests", body))


# ── Unraid Array widget ───────────────────────────────────────────────────────
@router.get("/unraid_array", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_unraid_array():
    arrays = await _rows(
        """SELECT n.hostname, n.display_name, a.state, a.parity_check_active,
                  a.parity_check_pct, a.parity_check_errors, a.last_sync_at, a.last_sync_errors
           FROM node_unraid_array a JOIN nodes n ON n.id = a.node_id
           ORDER BY n.hostname"""
    )
    disks = await _rows(
        """SELECT n.hostname, n.display_name, d.name, d.role, d.status, d.temp_c, d.size_gb
           FROM node_unraid_disks d JOIN nodes n ON n.id = d.node_id
           ORDER BY n.hostname, d.name LIMIT 60"""
    )
    if not arrays and not disks:
        return HTMLResponse(_page("Unraid Array", _empty('No enrolled endpoint reports an Unraid array')))

    parts = []
    if arrays:
        parts.append("<table><thead><tr><th>Host</th><th>State</th><th>Parity Check</th>"
                     "<th>Last Sync</th><th>Errors</th></tr></thead><tbody>" + "".join(
            f"<tr><td>{html.escape(str(a['display_name'] or a['hostname']))}</td>"
            f"<td>{_status_badge('online' if str(a.get('state') or '').upper() == 'STARTED' else 'offline')}"
            f" {html.escape(str(a.get('state') or ''))}</td>"
            f"<td>{(_fmt_pct(a['parity_check_pct']) if a.get('parity_check_active') else '—')}</td>"
            f"<td>{html.escape(_fmt_ts(a.get('last_sync_at')))}</td>"
            f"<td>{a.get('last_sync_errors') or 0}</td></tr>"
            for a in arrays
        ) + "</tbody></table>")
    if disks:
        parts.append('<div style="margin-top:12px"></div>'
                     "<table><thead><tr><th>Host</th><th>Disk</th><th>Role</th>"
                     "<th>Status</th><th>Temp</th><th>Size</th></tr></thead><tbody>" + "".join(
            f"<tr><td>{html.escape(str(d['display_name'] or d['hostname']))}</td>"
            f"<td>{html.escape(str(d['name']))}</td><td>{html.escape(str(d.get('role') or ''))}</td>"
            f"<td>{_status_badge('online' if str(d.get('status') or '') == 'DISK_OK' else 'offline')}</td>"
            f"<td>{(str(round(d['temp_c'])) + '°C') if d.get('temp_c') is not None else '—'}</td>"
            f"<td>{_fmt_n(d.get('size_gb'))} GB</td></tr>"
            for d in disks
        ) + "</tbody></table>")
    return HTMLResponse(_page("Unraid Array", "".join(parts)))


# ── Unraid Containers widget ──────────────────────────────────────────────────
@router.get("/unraid_containers", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_unraid_containers():
    rows = await _rows(
        """SELECT n.hostname, n.display_name, c.name, c.image, c.state, c.status
           FROM node_unraid_containers c JOIN nodes n ON n.id = c.node_id
           ORDER BY CASE WHEN c.state = 'running' THEN 1 ELSE 0 END, n.hostname, c.name LIMIT 60"""
    )
    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r['display_name'] or r['hostname']))}</td>"
            f"<td>{html.escape(str(r['name']))}</td>"
            f"<td>{_status_badge('online' if r.get('state') == 'running' else 'offline')}</td>"
            f"<td>{html.escape(str(r.get('status') or ''))}</td></tr>"
            for r in rows
        )
        body = ("<table><thead><tr><th>Host</th><th>Container</th><th>State</th><th>Status</th></tr></thead>"
                f"<tbody>{trs}</tbody></table>")
    else:
        body = _empty('No Unraid host is reporting containers')
    return HTMLResponse(_page("Unraid Containers", body))


# ── Unraid VMs widget ─────────────────────────────────────────────────────────
@router.get("/unraid_vms", response_class=HTMLResponse, include_in_schema=False,
            dependencies=[Depends(require_suite_token)])
async def widget_unraid_vms():
    rows = await _rows(
        """SELECT n.hostname, n.display_name, v.name, v.state
           FROM node_unraid_vms v JOIN nodes n ON n.id = v.node_id
           ORDER BY CASE WHEN v.state = 'running' THEN 1 ELSE 0 END, n.hostname, v.name LIMIT 60"""
    )
    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r['display_name'] or r['hostname']))}</td>"
            f"<td>{html.escape(str(r['name']))}</td>"
            f"<td>{_status_badge('online' if r.get('state') == 'running' else 'offline')}"
            f" {html.escape(str(r.get('state') or ''))}</td></tr>"
            for r in rows
        )
        body = ("<table><thead><tr><th>Host</th><th>VM</th><th>State</th></tr></thead>"
                f"<tbody>{trs}</tbody></table>")
    else:
        body = _empty('No Unraid host is reporting virtual machines')
    return HTMLResponse(_page("Unraid VMs", body))


# ── Param option pickers ──────────────────────────────────────────────────────
# Reads live state rather than a static list, so an endpoint enrolled or
# decommissioned after a NOC screen was built shows up (or drops out) the next
# time the editor opens the param — no manifest edit and no pktHub change needed.
@router.get("/options/nodes", dependencies=[Depends(require_suite_token)])
async def widget_options_nodes():
    rows = await _rows(
        "SELECT id, hostname, display_name FROM nodes WHERE is_active=1 ORDER BY hostname"
    )
    return JSONResponse([
        {"value": str(r["id"]), "label": r["display_name"] or r["hostname"]} for r in rows
    ])
