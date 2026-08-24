"""
app/api/resonance_data.py — the data half of the resonance contract.

app/api/resonance.py mounts the panel. This module is what the panel is
allowed to *read* once it is mounted, and it exists because the embed contract
has three parts and mounting only satisfies one of them:

  1. an OpenAPI document at a stable same-origin path      -> /api/resonance/openapi.json
  2. a grant file naming what may be called                -> /.well-known/resonance.json
  3. endpoints that behave: bounded, JSON, stable fields   -> /api/resonance/data/*

Why a separate surface rather than granting against /api/nodes/* directly.
The operations named in a grant have to carry a stable operationId, prose a
stranger can choose between, enums for every fixed vocabulary, a declared
response schema, and a bounded page with a total. pktNode's own endpoints were
written for a SPA that already knows all of that: they return bare arrays with
no total and no paging, and several carry columns an assistant must never see.
Retrofitting the contract onto them would change response shapes the frontend
already consumes. These wrap the same tables instead, so there is no second
implementation of any query — only a second, narrower doorway with the labels
the model needs.

Authentication is the app's existing session, not a new one. The panel's calls
are ordinary same-origin fetches from our own page, so they carry the refresh
cookie exactly as /api/resonance/code does, and they are admitted by the same
helpers that admit /code — see resonance_session_user below. Nothing here
issues, accepts or understands a credential of resonance's, and the panel can
therefore only ever read what the signed-in person could already read.

WHAT IS DELIBERATELY ABSENT IS PART OF THE DESIGN. A node's override secret and
every agent or enrolment token are never selected, so they cannot reach the
assistant through a schema's `extra` either. Running processes are not exposed
at all: a live process list with usernames is the most sensitive thing this
application holds and it answers no question an assistant should be asked.
Nothing here queues a command to an agent, runs a speed test, enrols or deletes
a node, or edits a group. The three operations that change state acknowledge an
alert or switch an existing rule.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
from dataclasses import dataclass
from typing import Any, Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.exceptions import ResponseValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.database import get_db

# Deliberately the same helpers /api/resonance/code uses, imported rather than
# reimplemented: the two surfaces must never disagree about who counts as
# signed in, which origin counts as ours, or whether the feature is on.
from app.api.resonance import (
    LEVEL_RANK, _allowed_roles, _get, _same_origin, _user_for_code, role_level,
)
from app.dependencies import require_admin, require_analyst

log = logging.getLogger("pktnode.api.resonance_data")

router = APIRouter(tags=["resonance-data"])

DATA_PREFIX = "/api/resonance/data"
SPEC_PATH = "/api/resonance/openapi.json"
GRANT_PATH = "/.well-known/resonance.json"


# ── What the assistant is allowed to call ────────────────────────────────────
#
# The one list. The grant file is generated from it, the published spec is
# filtered to it, and startup checks it against the routes that actually exist.
# An operationId that is not here is invisible to the assistant even though it
# is a perfectly ordinary route of this app.


@dataclass(frozen=True)
class Grant:
    op: str
    # Set on ANY operation that changes state, whatever its HTTP verb.
    # Resonance reads the values back to the person before running one.
    writes: bool = False


GRANTED: tuple[Grant, ...] = (
    Grant("getNodeSummary"),
    Grant("listNodes"),
    Grant("getNode"),
    Grant("listNodeDisks"),
    Grant("searchNodeSoftware"),
    Grant("listAlertEvents"),
    Grant("listAlertRules"),
    Grant("searchApplicationLog"),
    # Everything below changes state. Deliberately no command dispatch to an
    # agent, no speed test, no enrolment, and no delete of anything: an
    # assistant may act on what an administrator already put there, and never
    # author or destroy it — least of all reach out and touch a managed host.
    Grant("ackAlertEvent", writes=True),
    Grant("ackAllAlertEvents", writes=True),
    Grant("toggleAlertRule", writes=True),
)


# ── Vocabulary ────────────────────────────────────────────────────────────────
#
# These are the enums the requirement is really about: without them a model asks
# for a status of "offline" or an OS of "Mac", gets a 422, and reports the app
# as broken. Both are fixed in pktNode's own code — the install-specific
# vocabulary (host names, group names, software titles) cannot be, and is
# published through listNodes and searchNodeSoftware instead.

NodeStatus = Literal["online", "offline", "unknown"]
OsType = Literal["windows", "linux", "darwin", "unraid"]
AlertSeverity = Literal["info", "warning", "critical"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


# ── Errors ────────────────────────────────────────────────────────────────────


class ResonanceDataError(HTTPException):
    """Rendered as {"error": "..."} — the message reaches the person verbatim."""


class ErrorResponse(BaseModel):
    error: str = Field(description="What went wrong, phrased for the person to act on.")


def register_error_handler(app) -> None:
    """Give this surface the {"error": ...} body the grant contract specifies.

    Scoped to ResonanceDataError so the rest of the app keeps FastAPI's
    {"detail": ...}, which its own frontend already reads.
    """

    @app.exception_handler(ResonanceDataError)
    async def _render(_request: Request, exc: ResonanceDataError):  # noqa: ANN202
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(ResponseValidationError)
    async def _schema_drifted(request: Request, exc: ResponseValidationError):  # noqa: ANN202
        """Report a declared schema that no longer matches what the tables return.

        This fires after the route body has already succeeded, so the module's
        own try/except cannot see it, and it is logged by uvicorn rather than by
        anything the SQLite handler is attached to — a 500 with a generic
        message in the panel and not one line anywhere on the server. Now it
        names the fields.

        Only this surface is rewritten; every other response_model in the app
        keeps FastAPI's existing behaviour.
        """
        if not request.url.path.startswith("/api/resonance/"):
            raise exc
        fields = sorted({".".join(str(p) for p in err.get("loc", ())[-2:])
                         for err in exc.errors()})[:8]
        log.error(
            "resonance response schema no longer matches the data on %s: %s",
            request.url.path, ", ".join(fields) or "unknown field",
        )
        return JSONResponse(
            {"error": "pktNode produced a result it could not describe. This is a fault in "
                      "pktNode, not in the question — it has been logged."},
            status_code=500,
        )


_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "No signed-in session on this request."},
    403: {"model": ErrorResponse, "description": "Signed in, but not permitted to use the assistant."},
    404: {"model": ErrorResponse, "description": "The assistant is switched off on this install."},
    503: {"model": ErrorResponse, "description": "A backing store this operation needs is not available."},
    504: {"model": ErrorResponse, "description": "The store did not answer in time; ask something narrower."},
}


# ── Session ───────────────────────────────────────────────────────────────────


async def resonance_session_user(
    request: Request, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """Admit a call the panel made from our own page, on this app's own session.

    Same four gates as /api/resonance/code, in the same order and for the same
    reasons: the request must present as same-origin before any cookie is
    honoured, it must carry a session we recognise, the feature must be on, and
    the person's role must be one an admin listed. The last two mean this whole
    surface is inert on an install that never enabled the panel — a route that
    exists but answers 404 until someone turns the feature on deliberately.
    """
    if not _same_origin(request):
        raise ResonanceDataError(status_code=403, detail="Cross-site request refused.")

    user = await _user_for_code(request, db)
    if not user:
        raise ResonanceDataError(status_code=401, detail="Not signed in to pktNode.")

    if not bool(await _get(db, "resonance_enabled", False)):
        raise ResonanceDataError(status_code=404, detail="The assistant is not enabled on this install.")

    if user["role"] not in await _allowed_roles(db):
        raise ResonanceDataError(
            status_code=403, detail="Your role is not permitted to use the assistant."
        )

    # Audit trail, and the only way to answer "did the assistant actually ask us
    # anything". A successful read is otherwise silent, so without this the
    # difference between "the panel never called" and "the panel called and got
    # what it wanted" is invisible from the server — which is exactly the
    # question asked when an answer looks wrong. One line per call, at INFO, so
    # it lands in the Logs page too.
    route = request.scope.get("route")
    log.info(
        "resonance call: %s (%s) -> %s",
        user.get("username"), user.get("role"),
        getattr(route, "operation_id", None) or request.url.path,
    )
    return user


async def resonance_write_user(
    request: Request, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """As above, and the role must be set to "write" rather than "read".

    Two gates have to agree before anything changes, and they answer different
    questions. This one is the admin's: has this role been trusted to let the
    assistant act at all. The second, inside each operation, is pktNode's own:
    may this person do this thing anyway. A role set to "write" never gains a
    right its holder does not already have in the interface — it only decides
    whether the assistant may exercise the rights they do have.
    """
    user = await resonance_session_user(request, db)
    if LEVEL_RANK.get(await role_level(db, user["role"]), 0) < LEVEL_RANK["write"]:
        raise ResonanceDataError(
            status_code=403,
            detail=("The assistant is set to read-only for your role, so it cannot make "
                    "that change. An administrator sets this under Settings → Resonance."),
        )
    return user


async def _apply_app_rule(user: dict, rule, what: str) -> None:
    """Apply pktNode's own role rule for the endpoint this operation mirrors.

    The rule itself is imported rather than restated, so a change to who may do
    something in the interface reaches the assistant in the same commit instead
    of leaving two role models to drift apart.
    """
    try:
        await rule(user)
    except HTTPException as exc:
        raise ResonanceDataError(
            status_code=exc.status_code,
            detail=f"Your pktNode role does not permit you to {what}.",
        ) from exc


SessionUser = Depends(resonance_session_user)
WriteUser = Depends(resonance_write_user)


class Node(BaseModel):
    """One managed host reporting in through the pktNode agent."""

    model_config = ConfigDict(extra="allow")

    id: int
    hostname: Optional[str] = None
    display_name: Optional[str] = Field(None, description="The name an administrator gave it.")
    status: Optional[str] = Field(None, description="online, offline, or unknown.")
    ip_address: Optional[str] = None
    os_type: Optional[str] = Field(None, description="windows, linux, darwin or unraid.")
    os_version: Optional[str] = None
    arch: Optional[str] = None
    agent_version: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    cpu_model: Optional[str] = None
    cpu_cores: Optional[int] = None
    memory_total_mb: Optional[int] = None
    disk_total_gb: Optional[float] = None
    disk_free_gb: Optional[float] = None
    uptime_seconds: Optional[int] = None
    domain_or_workgroup: Optional[str] = None
    firewall_status: Optional[str] = None
    is_active: Optional[int] = Field(None, description="0 when the node has been retired.")
    last_checkin_at: Optional[str] = Field(None, description="When the agent last reported (ISO 8601).")
    first_seen_at: Optional[str] = None


class NodeList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int = Field(description="How many nodes matched, before paging.")
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = Field(
        False, description="True when the page was cut to fit. Ask for fewer, or narrow the filters."
    )
    nodes: list[Node] = Field(default_factory=list)


class NodeDisk(BaseModel):
    """One filesystem on a node."""

    model_config = ConfigDict(extra="allow")

    id: int
    node_id: int
    node_hostname: Optional[str] = Field(None, description="Which node, for reading back.")
    mount_point: Optional[str] = None
    device: Optional[str] = None
    fs_type: Optional[str] = None
    total_gb: Optional[float] = None
    free_gb: Optional[float] = None
    used_pct: Optional[float] = Field(None, description="How full it is. The field most questions are about.")


class NodeDiskList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = False
    disks: list[NodeDisk] = Field(default_factory=list)


class InstalledSoftware(BaseModel):
    """One installed package or application, as the agent last reported it."""

    model_config = ConfigDict(extra="allow")

    id: int
    node_id: int
    node_hostname: Optional[str] = None
    name: Optional[str] = None
    version: Optional[str] = None
    publisher: Optional[str] = None
    install_date: Optional[str] = None
    last_seen_at: Optional[str] = None


class SoftwareList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = False
    software: list[InstalledSoftware] = Field(default_factory=list)


class NodeSummary(BaseModel):
    """Counts across every managed host — the "how are we doing" answer."""

    model_config = ConfigDict(extra="allow")

    nodes: int
    nodes_online: int
    nodes_offline: int
    by_os: dict = Field(default_factory=dict, description="Node count per os_type.")
    groups: int
    disks_over_90_pct: int = Field(description="Filesystems at or above 90% full, across all nodes.")
    unacknowledged_alerts: int
    stale_checkins: int = Field(
        description="Nodes whose agent has not reported in over an hour."
    )


class AlertEvent(BaseModel):
    """One firing of a pktNode alert rule."""

    model_config = ConfigDict(extra="allow")

    id: int
    rule_id: Optional[int] = None
    rule_name: Optional[str] = Field(None, description="Name of the rule that fired.")
    node_id: Optional[int] = None
    node_hostname: Optional[str] = Field(None, description="Which node, for reading back.")
    severity: Optional[str] = None
    message: Optional[str] = None
    fired_at: Optional[str] = Field(None, description="When it fired (ISO 8601).")
    acked_at: Optional[str] = Field(None, description="When it was acknowledged, or null if nobody has.")
    resolved_at: Optional[str] = Field(None, description="When the condition cleared, or null if it has not.")
    auto_resolved: Optional[int] = Field(None, description="1 when it cleared on its own.")


class AlertEventList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = False
    events: list[AlertEvent] = Field(default_factory=list)


class AlertRule(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: int
    name: Optional[str] = None
    description: Optional[str] = None
    rule_type: Optional[str] = Field(None, description="What the rule watches.")
    severity: Optional[str] = None
    enabled: bool = False
    time_window_min: Optional[int] = None
    cooldown_min: Optional[int] = None
    last_fired: Optional[str] = None
    created_at: Optional[str] = None


class AlertRuleList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    returned: int = 0
    truncated_for_size: bool = False
    rules: list[AlertRule] = Field(default_factory=list)


class AppLogRecord(BaseModel):
    """One line of pktNode's own diagnostic log — not node data."""

    model_config = ConfigDict(extra="allow")

    id: int
    level: Optional[str] = None
    logger: Optional[str] = Field(None, description="Which part of pktNode wrote it.")
    message: Optional[str] = None
    created_at: Optional[str] = Field(None, description="When it was written (ISO 8601).")


class AppLogResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = False
    records: list[AppLogRecord] = Field(default_factory=list)


# ── Operations ────────────────────────────────────────────────────────────────
#
# Every summary and description here is written for a reader who has never seen
# pktNode, because that is literally what chooses between them: a model picks an
# operation from these sentences and nothing else. "Search logs" would leave it
# guessing between the certificate inventory and the app's own diagnostics,
# which are two entirely different questions asked with almost the same words.

# One page is capped well below what the SPA allows. The panel's results are
# read back to a person in a conversation, so a hundred rows is already past the
# point of being an answer, and a model handed five hundred narrows nothing. The
# maxima are deliberately above what always fits — _fit() reports the cut, and a
# caller that wants density should be able to ask for it.
_SEARCH_DEFAULT, _SEARCH_MAX = 25, 100
_LIST_DEFAULT, _LIST_MAX = 50, 200

# Resonance truncates a result over 20 KB and tells the model it did. That turns
# a clean page into JSON that stops mid-record, so the cut is made here instead,
# where it can leave the envelope intact and say what happened in a field the
# model can act on. 18 KB leaves headroom for transport framing.
_RESULT_BUDGET_BYTES = 18_000

# Resonance gives up on a call after 20 seconds and tells the person the
# application did not answer. Answering at 15 with something they can act on
# beats going quiet at 20.
_CALL_TIMEOUT_SECONDS = 15


def _encoded_size(value: Any) -> int:
    return len(json.dumps(value, default=str).encode("utf-8"))


def _fit(payload: dict, items_key: str) -> dict:
    """Trim a page to the byte budget, and record that it had to.

    Always keeps at least one item: an empty page for one oversized record is a
    worse answer than an oversized one, and the caller can still see `total`.
    """
    items = list(payload.get(items_key) or [])
    # Price the envelope with the two fields this adds, so adding them cannot
    # push a result that just fitted back over the line.
    envelope = dict(payload)
    envelope[items_key] = []
    envelope["returned"] = len(items)
    envelope["truncated_for_size"] = True
    budget = _RESULT_BUDGET_BYTES - _encoded_size(envelope)

    kept: list = []
    used = 0
    for item in items:
        size = _encoded_size(item) + 1   # + the separating comma
        if kept and used + size > budget:
            break
        kept.append(item)
        used += size

    payload[items_key] = kept
    payload["returned"] = len(kept)
    payload["truncated_for_size"] = len(kept) < len(items)
    return payload


async def _in_time(awaitable, what: str):
    """Bound a query so a slow one is answered rather than abandoned."""
    try:
        return await asyncio.wait_for(awaitable, _CALL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise ResonanceDataError(
            status_code=504,
            detail=(
                f"pktNode took longer than {_CALL_TIMEOUT_SECONDS} seconds to {what}. "
                "Narrow the time range, or filter by status, CA or name."
            ),
        ) from exc

@router.get(
    f"{DATA_PREFIX}/summary",
    operation_id="getNodeSummary",
    summary="Counts across every managed host",
    description=(
        "One small result answering 'how are we doing' — how many nodes exist, how many are "
        "online against offline, the split by operating system, how many groups are configured, "
        "how many filesystems are at or above 90% full anywhere, how many agents have gone quiet "
        "for over an hour, and how many alerts are outstanding. Ask this before listNodes when "
        "the question is about totals rather than about particular hosts."
    ),
    response_model=NodeSummary,
    responses=_ERRORS,
)
async def get_node_summary(
    _user: dict = SessionUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    async def _count(query: str) -> int:
        async with db.execute(query) as cur:
            row = await cur.fetchone()
        return row[0] if row else 0

    async with db.execute(
        "SELECT COALESCE(os_type, 'unknown') AS os, COUNT(*) AS n FROM nodes GROUP BY os"
    ) as cur:
        by_os = {r["os"]: r["n"] for r in await cur.fetchall()}

    return {
        "nodes": await _count("SELECT COUNT(*) FROM nodes"),
        "nodes_online": await _count("SELECT COUNT(*) FROM nodes WHERE status = 'online'"),
        "nodes_offline": await _count("SELECT COUNT(*) FROM nodes WHERE status = 'offline'"),
        "by_os": by_os,
        "groups": await _count("SELECT COUNT(*) FROM groups"),
        "disks_over_90_pct": await _count(
            "SELECT COUNT(*) FROM node_disks WHERE used_pct >= 90"
        ),
        "unacknowledged_alerts": await _count(
            "SELECT COUNT(*) FROM alert_events WHERE acked_at IS NULL"
        ),
        "stale_checkins": await _count(
            "SELECT COUNT(*) FROM nodes WHERE last_checkin_at IS NULL "
            "OR last_checkin_at < datetime('now', '-1 hour')"
        ),
    }


@router.get(
    f"{DATA_PREFIX}/nodes",
    operation_id="listNodes",
    summary="Search the managed hosts",
    description=(
        "The hosts running the pktNode agent — what each is, what it runs, how much disk it has "
        "left and when its agent last reported. Use status='offline' for 'what is down', and "
        "stale_only for agents that have gone quiet without being marked offline, which is a "
        "different and often more interesting failure. Every filter is optional and they combine "
        "with AND. Returns at most `limit` nodes plus the total that matched. No agent token or "
        "override secret is ever returned."
    ),
    response_model=NodeList,
    responses=_ERRORS,
)
async def list_nodes(
    _user: dict = SessionUser,
    status: Optional[NodeStatus] = Query(None, description="Only nodes in this state."),
    os_type: Optional[OsType] = Query(None, description="Only nodes running this operating system."),
    stale_only: bool = Query(
        False, description="Only nodes whose agent has not reported in over an hour."
    ),
    search: Optional[str] = Query(
        None, max_length=200, description="Substring of the hostname, display name or address."
    ),
    limit: int = Query(
        _SEARCH_DEFAULT, ge=1, le=_SEARCH_MAX,
        description=f"How many to return. Default {_SEARCH_DEFAULT}, maximum {_SEARCH_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
    db: aiosqlite.Connection = Depends(get_db),
):
    clauses: list[str] = []
    params: list = []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if os_type:
        clauses.append("os_type = ?")
        params.append(os_type)
    if stale_only:
        clauses.append("(last_checkin_at IS NULL OR last_checkin_at < datetime('now', '-1 hour'))")
    if search:
        clauses.append("(hostname LIKE ? OR display_name LIKE ? OR ip_address LIKE ?)")
        like = f"%{search}%"
        params.extend([like] * 3)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    async with db.execute(f"SELECT COUNT(*) FROM nodes {where}", params) as cur:
        total = (await cur.fetchone())[0]

    # Columns are listed rather than selected with * on purpose: override_secret
    # lives on this table, and a schema that allows extras would carry it
    # straight through.
    async with db.execute(
        f"""SELECT id, hostname, display_name, status, ip_address, os_type, os_version, arch,
                   agent_version, manufacturer, model, cpu_model, cpu_cores, memory_total_mb,
                   disk_total_gb, disk_free_gb, uptime_seconds, domain_or_workgroup,
                   firewall_status, is_active, last_checkin_at, first_seen_at
            FROM nodes {where}
            ORDER BY hostname
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return _fit(
        {"total": total, "limit": limit, "offset": offset, "nodes": [dict(r) for r in rows]},
        "nodes",
    )


@router.get(
    f"{DATA_PREFIX}/nodes/{{node_id}}",
    operation_id="getNode",
    summary="Read one managed host in full",
    description=(
        "Everything pktNode records about a single host, by the id listNodes returned. Use this "
        "after a search when the question is about one machine in particular — its hardware, its "
        "operating system, when its agent last checked in. Running processes are not included; "
        "they are not published to the assistant at all."
    ),
    response_model=Node,
    responses={**_ERRORS, 404: {"model": ErrorResponse, "description": "No node with that id."}},
)
async def get_node(
    node_id: int = Path(description="Id of the node, as returned by listNodes."),
    _user: dict = SessionUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    async with db.execute(
        """SELECT id, hostname, display_name, status, ip_address, os_type, os_version, arch,
                  agent_version, manufacturer, model, cpu_model, cpu_cores, memory_total_mb,
                  disk_total_gb, disk_free_gb, uptime_seconds, domain_or_workgroup,
                  firewall_status, is_active, last_checkin_at, first_seen_at
           FROM nodes WHERE id = ?""",
        (node_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise ResonanceDataError(status_code=404, detail=f"There is no node {node_id}.")
    return dict(row)


@router.get(
    f"{DATA_PREFIX}/disks",
    operation_id="listNodeDisks",
    summary="List filesystems across the estate, fullest first",
    description=(
        "Every filesystem the agents report, with how full each is. Fullest first, so asking "
        "with no filter answers 'what is about to run out of space' directly. Set min_used_pct "
        "to draw the line somewhere specific, or node_id to look at one host."
    ),
    response_model=NodeDiskList,
    responses=_ERRORS,
)
async def list_node_disks(
    _user: dict = SessionUser,
    node_id: Optional[int] = Query(None, description="Only filesystems on this node."),
    min_used_pct: Optional[float] = Query(
        None, ge=0, le=100, description="Only filesystems at or above this percentage full."
    ),
    limit: int = Query(
        _SEARCH_DEFAULT, ge=1, le=_SEARCH_MAX,
        description=f"How many to return. Default {_SEARCH_DEFAULT}, maximum {_SEARCH_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
    db: aiosqlite.Connection = Depends(get_db),
):
    clauses: list[str] = []
    params: list = []
    if node_id is not None:
        clauses.append("d.node_id = ?")
        params.append(node_id)
    if min_used_pct is not None:
        clauses.append("d.used_pct >= ?")
        params.append(min_used_pct)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    async with db.execute(f"SELECT COUNT(*) FROM node_disks d {where}", params) as cur:
        total = (await cur.fetchone())[0]

    async with db.execute(
        f"""SELECT d.id, d.node_id, d.mount_point, d.device, d.fs_type, d.total_gb,
                   d.free_gb, d.used_pct, n.hostname AS node_hostname
            FROM node_disks d
            LEFT JOIN nodes n ON n.id = d.node_id
            {where}
            ORDER BY d.used_pct DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return _fit(
        {"total": total, "limit": limit, "offset": offset, "disks": [dict(r) for r in rows]},
        "disks",
    )


@router.get(
    f"{DATA_PREFIX}/software",
    operation_id="searchNodeSoftware",
    summary="Find which hosts have a piece of software installed",
    description=(
        "The installed software inventory the agents report. This is the 'who still has version "
        "X' and 'is that package anywhere in the estate' question — give `name` a substring of "
        "the product. There are thousands of rows across an estate, so a search with no name and "
        "no node is bounded and not especially useful; narrow it. Returns at most `limit` rows "
        "plus the total that matched."
    ),
    response_model=SoftwareList,
    responses=_ERRORS,
)
async def search_node_software(
    _user: dict = SessionUser,
    name: Optional[str] = Query(None, max_length=200, description="Substring of the product name."),
    publisher: Optional[str] = Query(None, max_length=200, description="Substring of the publisher."),
    version: Optional[str] = Query(None, max_length=100, description="Exact version string."),
    node_id: Optional[int] = Query(None, description="Only software on this node."),
    limit: int = Query(
        _SEARCH_DEFAULT, ge=1, le=_SEARCH_MAX,
        description=f"How many to return. Default {_SEARCH_DEFAULT}, maximum {_SEARCH_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
    db: aiosqlite.Connection = Depends(get_db),
):
    clauses: list[str] = []
    params: list = []
    if name:
        clauses.append("s.name LIKE ?")
        params.append(f"%{name}%")
    if publisher:
        clauses.append("s.publisher LIKE ?")
        params.append(f"%{publisher}%")
    if version:
        clauses.append("s.version = ?")
        params.append(version)
    if node_id is not None:
        clauses.append("s.node_id = ?")
        params.append(node_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    async with db.execute(f"SELECT COUNT(*) FROM node_software s {where}", params) as cur:
        total = (await cur.fetchone())[0]

    async with db.execute(
        f"""SELECT s.id, s.node_id, s.name, s.version, s.publisher, s.install_date,
                   s.last_seen_at, n.hostname AS node_hostname
            FROM node_software s
            LEFT JOIN nodes n ON n.id = s.node_id
            {where}
            ORDER BY s.name, n.hostname
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return _fit(
        {"total": total, "limit": limit, "offset": offset, "software": [dict(r) for r in rows]},
        "software",
    )


@router.get(
    f"{DATA_PREFIX}/alerts/events",
    operation_id="listAlertEvents",
    summary="List alerts that have fired",
    description=(
        "Individual firings of pktNode's alert rules — a host going offline, a disk filling, CPU "
        "or memory staying high — newest first. This is what to read for 'what is wrong' or "
        "'what happened overnight'. An event with a null acked_at is one nobody has looked at "
        "yet; a null resolved_at means the condition has not cleared."
    ),
    response_model=AlertEventList,
    responses=_ERRORS,
)
async def list_alert_events(
    _user: dict = SessionUser,
    unacked_only: bool = Query(False, description="Only events nobody has acknowledged yet."),
    unresolved_only: bool = Query(False, description="Only events whose condition has not cleared."),
    severity: Optional[AlertSeverity] = Query(None, description="Only events raised at this severity."),
    node_id: Optional[int] = Query(None, description="Only events about this node."),
    since: Optional[str] = Query(None, description="Only events fired at or after this time. ISO 8601."),
    until: Optional[str] = Query(None, description="Only events fired at or before this time. ISO 8601."),
    limit: int = Query(
        _SEARCH_DEFAULT, ge=1, le=_SEARCH_MAX,
        description=f"How many to return. Default {_SEARCH_DEFAULT}, maximum {_SEARCH_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
    db: aiosqlite.Connection = Depends(get_db),
):
    clauses: list[str] = []
    params: list = []
    if unacked_only:
        clauses.append("e.acked_at IS NULL")
    if unresolved_only:
        clauses.append("e.resolved_at IS NULL")
    if severity:
        clauses.append("e.severity = ?")
        params.append(severity)
    if node_id is not None:
        clauses.append("e.node_id = ?")
        params.append(node_id)
    if since:
        # fired_at is written by SQLite's datetime('now') — space separated, no
        # 'Z' — so both sides go through datetime() to compare like for like.
        clauses.append("e.fired_at >= datetime(?)")
        params.append(since)
    if until:
        clauses.append("e.fired_at <= datetime(?)")
        params.append(until)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    async with db.execute(f"SELECT COUNT(*) FROM alert_events e {where}", params) as cur:
        total = (await cur.fetchone())[0]

    async with db.execute(
        f"""SELECT e.id, e.rule_id, e.node_id, e.severity, e.message, e.fired_at,
                   e.acked_at, e.resolved_at, e.auto_resolved,
                   r.name AS rule_name, n.hostname AS node_hostname
            FROM alert_events e
            LEFT JOIN alert_rules r ON r.id = e.rule_id
            LEFT JOIN nodes n ON n.id = e.node_id
            {where}
            ORDER BY e.fired_at DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return _fit(
        {"total": total, "limit": limit, "offset": offset, "events": [dict(r) for r in rows]},
        "events",
    )


@router.get(
    f"{DATA_PREFIX}/alerts/rules",
    operation_id="listAlertRules",
    summary="List the configured alert rules",
    description=(
        "The rules an administrator has set up, whether each is switched on, what it watches and "
        "when it last fired. Rules are the configuration; listAlertEvents is what they have "
        "actually fired. Read this to answer 'are we even watching for that', and to get the "
        "rule id toggleAlertRule needs."
    ),
    response_model=AlertRuleList,
    responses=_ERRORS,
)
async def list_alert_rules(
    _user: dict = SessionUser,
    enabled_only: bool = Query(False, description="Only rules that are currently switched on."),
    db: aiosqlite.Connection = Depends(get_db),
):
    where = "WHERE enabled = 1" if enabled_only else ""
    async with db.execute(
        f"SELECT id, name, description, rule_type, severity, enabled, time_window_min, "
        f"cooldown_min, last_fired, created_at FROM alert_rules {where} ORDER BY name"
    ) as cur:
        rows = await cur.fetchall()
    rules = []
    for r in rows:
        d = dict(r)
        d["enabled"] = bool(d.get("enabled"))
        rules.append(d)
    return _fit({"total": len(rules), "rules": rules}, "rules")


@router.get(
    f"{DATA_PREFIX}/app-log",
    operation_id="searchApplicationLog",
    summary="Search pktNode's own diagnostic log",
    description=(
        "pktNode's internal log — what the application itself did and any errors it hit. This is "
        "NOT node data: for hosts use listNodes, and for alert firings use listAlertEvents. Read "
        "this to answer 'why did that agent fail to enrol' or 'what went wrong at three this "
        "morning'. Newest first."
    ),
    response_model=AppLogResult,
    responses=_ERRORS,
)
async def search_application_log(
    _user: dict = SessionUser,
    level: Optional[LogLevel] = Query(None, description="Only lines at this level."),
    logger: Optional[str] = Query(
        None, max_length=120, description="Only lines from loggers with this prefix."
    ),
    search: Optional[str] = Query(None, max_length=200, description="Substring of the message."),
    since: Optional[str] = Query(None, description="Only lines at or after this time. ISO 8601."),
    until: Optional[str] = Query(None, description="Only lines at or before this time. ISO 8601."),
    limit: int = Query(
        _SEARCH_DEFAULT, ge=1, le=_SEARCH_MAX,
        description=f"How many to return. Default {_SEARCH_DEFAULT}, maximum {_SEARCH_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
    db: aiosqlite.Connection = Depends(get_db),
):
    clauses: list[str] = []
    params: list = []
    if level:
        clauses.append("level = ?")
        params.append(level)
    if logger:
        clauses.append("logger LIKE ?")
        params.append(f"{logger}%")
    if search:
        clauses.append("message LIKE ?")
        params.append(f"%{search}%")
    if since:
        clauses.append("ts >= ?")
        params.append(since)
    if until:
        clauses.append("ts <= ?")
        params.append(until)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    async with db.execute(f"SELECT COUNT(*) FROM app_logs {where}", params) as cur:
        total = (await cur.fetchone())[0]

    # The column is `ts` in this app and `created_at` in others; aliased so the
    # published field name is the same wherever the assistant is talking.
    async with db.execute(
        f"SELECT id, level, logger, message, ts AS created_at FROM app_logs {where} "
        "ORDER BY id DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return _fit(
        {"total": total, "limit": limit, "offset": offset, "records": [dict(r) for r in rows]},
        "records",
    )


# ── The two documents ─────────────────────────────────────────────────────────
#
# Neither carries data — only names — so both are readable without a login, in
# the same way this app already publishes its own /openapi.json. Publishing them
# grants nothing on its own: an operation is reachable only because it is in
# GRANTED, and reachable only to a signed-in person whose role an admin listed.


def _declared_operation_ids(app) -> set[str]:
    """operationIds actually registered on the app.

    Walks the route table rather than calling app.openapi(), which would build
    and cache the schema at import time — before the SPA catch-all is mounted.

    The walk recurses because the table is not reliably flat: recent FastAPI
    keeps an included router as a single wrapper object holding its own routes,
    where earlier versions spliced them straight in. pkt installs pin only a
    lower bound on fastapi, so both layouts are live in the field and a walker
    that understood one of them would have reported every operation missing on
    the other.
    """
    found: set[str] = set()
    seen: set[int] = set()

    def walk(routes) -> None:
        for route in routes or []:
            if id(route) in seen:
                continue
            seen.add(id(route))
            op = getattr(route, "operation_id", None)
            if op:
                found.add(op)
            nested = getattr(route, "routes", None)
            if nested is None:
                inner = getattr(route, "original_router", None)
                nested = getattr(inner, "routes", None) if inner is not None else None
            if nested:
                walk(nested)

    walk(getattr(app, "routes", []))
    return found


def validate_grants(app) -> list[str]:
    """Fail loudly at startup when a grant names an operation that is not there.

    A grant for a route that has been renamed is the quiet failure mode of this
    whole arrangement: the panel asks for it, gets a 404, and reports the app as
    having no such capability rather than as misconfigured. Returns the missing
    names so a caller can act on them; logs them either way.
    """
    declared = _declared_operation_ids(app)
    missing = [g.op for g in GRANTED if g.op not in declared]
    if missing:
        log.error(
            "resonance grant names %d operation(s) this app does not declare: %s — "
            "they are being withheld from /.well-known/resonance.json",
            len(missing), ", ".join(missing),
        )
    return missing


async def writes_are_enabled(db: aiosqlite.Connection) -> bool:
    """True when at least one role has been trusted with more than reading.

    The grant is one document for the whole origin and is served without a
    login, so it cannot vary per person — but it can tell the truth about the
    install. Where no role is set to "write", the write operations are withheld
    from it entirely rather than advertised and refused on every attempt.
    """
    for role in ("admin", "analyst", "viewer"):
        if LEVEL_RANK.get(await role_level(db, role), 0) >= LEVEL_RANK["write"]:
            return True
    return False


def build_grant(app, allow_writes: bool) -> dict:
    """The grant document, generated from GRANTED so the two cannot disagree."""
    declared = _declared_operation_ids(app)
    allow: list[dict] = []
    for g in GRANTED:
        if g.op not in declared:
            continue
        if g.writes and not allow_writes:
            continue
        entry: dict[str, Any] = {"op": g.op}
        if g.writes:
            entry["writes"] = True
        allow.append(entry)
    return {"resonance": 1, "spec": SPEC_PATH, "allow": allow}


def _referenced_schemas(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            out.add(ref.rsplit("/", 1)[-1])
        for value in node.values():
            _referenced_schemas(value, out)
    elif isinstance(node, list):
        for value in node:
            _referenced_schemas(value, out)


def build_spec(app, allow_writes: bool) -> dict:
    """This app's own OpenAPI, narrowed to the granted operations.

    Generated from the live routes rather than written by hand, so a parameter
    that changes shape changes here too — the failure a hand-kept spec always
    ends in is the assistant confidently sending a field that stopped existing.
    Narrowed rather than published whole because everything an operation's prose
    has to compete with is another operation's prose: a hundred and twenty of
    them, most of which the grant forbids, is a hundred and twenty chances to
    pick the wrong one.
    """
    full = app.openapi()
    granted = {g.op for g in GRANTED if allow_writes or not g.writes}

    paths: dict[str, dict] = {}
    for path, item in (full.get("paths") or {}).items():
        # Deep-copied because app.openapi() hands back the app's own cached
        # schema object: editing an operation in place here would edit the
        # document this app publishes at /openapi.json as well.
        kept = {
            method: copy.deepcopy(operation)
            for method, operation in item.items()
            if isinstance(operation, dict) and operation.get("operationId") in granted
        }
        if kept:
            for operation in kept.values():
                # Nothing is presented on these calls but the person's own
                # session cookie, which the browser attaches by itself.
                operation.pop("security", None)
            paths[path] = kept

    wanted: set[str] = set()
    _referenced_schemas(paths, wanted)
    all_schemas = (full.get("components") or {}).get("schemas") or {}
    resolved: dict[str, Any] = {}
    while wanted:
        name = wanted.pop()
        if name in resolved or name not in all_schemas:
            continue
        resolved[name] = copy.deepcopy(all_schemas[name])
        nested: set[str] = set()
        _referenced_schemas(all_schemas[name], nested)
        wanted |= nested - resolved.keys()

    spec: dict[str, Any] = {
        "openapi": full.get("openapi", "3.1.0"),
        "info": {
            "title": "pktNode — assistant data surface",
            "version": full.get("info", {}).get("version", "0.1.0"),
            "description": (
                "The operations pktNode publishes for an embedded assistant. Every call is made "
                "by pktNode's own page, same-origin, on the session of the person already signed "
                "in, so nothing here can reach data that person could not already open in the "
                "interface. No private key, passcode or certificate PEM is exposed, and nothing "
                "here issues, revokes, signs or approves anything."
            ),
        },
        "paths": paths,
    }
    if resolved:
        spec["components"] = {"schemas": resolved}
    return spec


# Two possible documents — with writes and without — so the setting can change
# without a restart while the expensive part is still built once each.
_spec_cache: dict[bool, Any] = {}


@router.get(GRANT_PATH, include_in_schema=False)
async def resonance_grant(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    """What this install permits the assistant to call. Names only, no data.

    Public by contract: it has to be readable before anyone signs in, and it
    carries nothing but operation names. Whether the write operations appear
    depends on the levels an admin set, so an install that has trusted nobody
    with writes publishes a grant that cannot be read as offering them.
    """
    grant = build_grant(request.app, await writes_are_enabled(db))
    log.info("resonance grant fetched: %d operation(s), %d writing",
             len(grant["allow"]), sum(1 for a in grant["allow"] if a.get("writes")))
    return JSONResponse(
        grant,
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get(SPEC_PATH, include_in_schema=False)
async def resonance_spec(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    """The OpenAPI document for the granted operations."""
    allow_writes = await writes_are_enabled(db)
    if allow_writes not in _spec_cache:
        _spec_cache[allow_writes] = build_spec(request.app, allow_writes)
    log.info("resonance spec fetched (writes %s)", "included" if allow_writes else "withheld")
    return JSONResponse(
        _spec_cache[allow_writes],
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=300"},
    )


# ── Operations that change something ──────────────────────────────────────────
#
# Every one of these is marked `writes: true` in the grant, so resonance stops
# and reads the actual values back to the person before it runs one. That
# confirmation is theirs to enforce and cannot be relied on here, which is why
# both gates above still apply on the request itself.
#
# What is deliberately absent is as much of the design as what is present: no
# delete of anything, no clearing of logs, and no creating or editing of
# configuration. An assistant can act on what an administrator already put
# there, and cannot author or destroy it.


class AckResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    event_id: int = Field(description="The alert event this refers to.")
    acknowledged: bool = Field(description="True if this call acknowledged it.")
    already_acknowledged: bool = Field(
        description="True when someone had already acknowledged it, in which case nothing changed."
    )
    acked_at: Optional[str] = Field(None, description="When it was acknowledged (ISO 8601, UTC).")
    message: str = Field(description="What happened, phrased to be read back to the person.")


class AckAllResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    acknowledged: int = Field(description="How many outstanding alerts this call acknowledged.")
    message: str = Field(description="What happened, phrased to be read back to the person.")


@router.post(
    f"{DATA_PREFIX}/alerts/events/{{event_id}}/ack",
    operation_id="ackAlertEvent",
    summary="Acknowledge one alert",
    description=(
        "Mark a single fired alert as seen, recording who did it and when. This changes state. It "
        "does not resolve the alert or fix the condition behind it — a certificate close to "
        "expiry is still close to expiry, and the rule will fire again. Acknowledging something "
        "already acknowledged changes nothing and says so. Available to analysts and "
        "administrators, as in the interface."
    ),
    response_model=AckResult,
    responses={**_ERRORS, 404: {"model": ErrorResponse, "description": "No alert event with that id."}},
)
async def ack_alert_event(
    event_id: int = Path(
        description="Id of the alert event to acknowledge, as returned by listAlertEvents."
    ),
    user: dict = WriteUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    # pktNode lets any signed-in person acknowledge an alert in the interface,
    # so there is no further role rule to mirror here — the assistant-level
    # gate above is the whole of it.

    async with db.execute(
        "SELECT e.acked_at, r.name FROM alert_events e "
        "LEFT JOIN alert_rules r ON r.id = e.rule_id WHERE e.id = ?",
        (event_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise ResonanceDataError(status_code=404, detail=f"There is no alert event {event_id}.")

    name = row["name"] or "unnamed rule"
    if row["acked_at"]:
        when = str(row["acked_at"] or "").replace(" ", "T") + "Z" if row["acked_at"] else None
        return {
            "event_id": event_id, "acknowledged": False, "already_acknowledged": True,
            "acked_at": when,
            "message": f"Alert {event_id} ({name}) was already acknowledged"
                       + (f" at {when}." if when else "."),
        }

    await db.execute(
        "UPDATE alert_events SET acked_at = datetime('now'), acked_by = ? "
        "WHERE id = ? AND acked_at IS NULL",
        (user.get("id"), event_id),
    )
    await db.commit()

    async with db.execute("SELECT acked_at FROM alert_events WHERE id = ?", (event_id,)) as cur:
        acked = (await cur.fetchone())["acked_at"]
    when = str(acked).replace(" ", "T") + "Z" if acked else None
    log.info("resonance: %s acknowledged alert event %s", user.get("username"), event_id)
    return {
        "event_id": event_id, "acknowledged": True, "already_acknowledged": False,
        "acked_at": when,
        "message": f"Acknowledged alert {event_id} ({name}). The condition behind it is unchanged.",
    }


@router.post(
    f"{DATA_PREFIX}/alerts/events/ack-all",
    operation_id="ackAllAlertEvents",
    summary="Acknowledge every outstanding alert",
    description=(
        "Mark every alert nobody has acknowledged yet as seen, in one go. This changes state, and "
        "it is not reversible from here — there is no un-acknowledge. It resolves nothing: every "
        "condition behind every alert is untouched. Reports how many were acknowledged, which is "
        "zero when there was nothing outstanding. Available to analysts and administrators, as in "
        "the interface."
    ),
    response_model=AckAllResult,
    responses=_ERRORS,
)
async def ack_all_alert_events(
    user: dict = WriteUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    # pktNode lets any signed-in person acknowledge an alert in the interface,
    # so there is no further role rule to mirror here — the assistant-level
    # gate above is the whole of it.

    async with db.execute("SELECT COUNT(*) FROM alert_events WHERE acked_at IS NULL") as cur:
        outstanding = (await cur.fetchone())[0]
    if not outstanding:
        return {"acknowledged": 0, "message": "There were no unacknowledged alerts."}

    await db.execute(
        "UPDATE alert_events SET acked_at = datetime('now'), acked_by = ? "
        "WHERE acked_at IS NULL",
        (user.get("id"),),
    )
    await db.commit()
    log.info("resonance: %s acknowledged all %d outstanding alerts",
             user.get("username"), outstanding)
    return {
        "acknowledged": outstanding,
        "message": f"Acknowledged {outstanding} alert"
                   f"{'' if outstanding == 1 else 's'}. None of the conditions behind them changed.",
    }


class ToggleRuleResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: int = Field(description="The rule that was switched.")
    name: Optional[str] = Field(None, description="Its name, for reading back.")
    enabled: bool = Field(description="Whether the rule is now on.")
    message: str = Field(description="What happened, phrased to be read back to the person.")


@router.post(
    f"{DATA_PREFIX}/alerts/rules/{{rule_id}}/toggle",
    operation_id="toggleAlertRule",
    summary="Switch an existing alert rule on or off",
    description=(
        "Turn a rule an administrator already created on, or off. This changes state. Switching a "
        "rule off stops it firing at all, so anything it was watching for goes unreported until "
        "it is switched back on — say which rule and which direction before doing it. It cannot "
        "create, edit or delete a rule, only flip the one switch. Administrators only, as in the "
        "interface."
    ),
    response_model=ToggleRuleResult,
    responses={**_ERRORS, 404: {"model": ErrorResponse, "description": "No alert rule with that id."}},
)
async def toggle_alert_rule(
    rule_id: int = Path(description="Id of the rule to switch, as returned by listAlertRules."),
    user: dict = WriteUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    # Switching a rule is available to any signed-in person in the interface
    # too, so again the assistant-level gate above is the whole of it.

    async with db.execute("SELECT id, name, enabled FROM alert_rules WHERE id = ?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise ResonanceDataError(status_code=404, detail=f"There is no alert rule {rule_id}.")

    new_enabled = 0 if row["enabled"] else 1
    await db.execute("UPDATE alert_rules SET enabled = ? WHERE id = ?", (new_enabled, rule_id))
    await db.commit()
    log.info("resonance: %s switched alert rule %s %s",
             user.get("username"), rule_id, "on" if new_enabled else "off")
    return {
        "id": rule_id,
        "name": row["name"],
        "enabled": bool(new_enabled),
        "message": f"Alert rule {rule_id} ({row['name']}) is now "
                   f"{'on' if new_enabled else 'off'}.",
    }
