"""
Live remote terminal relay.

The agent keeps one persistent outbound WebSocket open to this server as
a control channel — separate from, and in addition to, its periodic HTTP
check-in. An admin's browser opens a second WebSocket to this server when
it wants a shell. This module holds the in-memory registry of both sides
and relays JSON-framed messages between them.

The managed node never accepts an inbound connection of any kind: the
agent always dials out, exactly like its check-ins, so a live terminal
needs no firewall changes on the node's end.

Single-process, in-memory registry — correct for pktNode's one-uvicorn-
worker deployment. Scaling to multiple server processes would need an
external broker (e.g. redis pub/sub) instead of the plain dicts below.

Wire protocol (JSON text frames both directions):

  Server -> Agent (control channel):
    {"type": "start",  "session_id": str, "cols": int, "rows": int}
    {"type": "input",  "session_id": str, "data": "<base64>"}
    {"type": "resize", "session_id": str, "cols": int, "rows": int}
    {"type": "stop",   "session_id": str}

  Agent -> Server (control channel):
    {"type": "started", "session_id": str}
    {"type": "output",  "session_id": str, "data": "<base64>"}
    {"type": "exited",  "session_id": str, "code": int}
    {"type": "error",   "session_id": str, "message": str}

  Server -> Browser (session channel) — session_id stripped, browser only
  ever has the one session it opened:
    {"type": "status", "state": "connecting"|"active"|"exited"|"error", "message": str}
    {"type": "output", "data": "<base64>"}

  Browser -> Server (session channel):
    {"type": "input",  "data": "<base64>"}
    {"type": "resize", "cols": int, "rows": int}
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from typing import Optional

from fastapi import WebSocket
from starlette.websockets import WebSocketState

log = logging.getLogger("pktnode.terminal")


class AgentLink:
    """One node's persistent control-channel connection."""

    def __init__(self, ws: WebSocket, node_id: int, hostname: str):
        self.ws = ws
        self.node_id = node_id
        self.hostname = hostname
        self._send_lock = asyncio.Lock()
        self.session_id: Optional[str] = None
        self.browser: Optional["BrowserLink"] = None

    async def send(self, payload: dict) -> None:
        async with self._send_lock:
            if self.ws.client_state == WebSocketState.CONNECTED:
                await self.ws.send_text(json.dumps(payload))


class BrowserLink:
    """One admin's terminal-tab connection for a single session."""

    def __init__(self, ws: WebSocket, session_id: str, opened_by: str):
        self.ws = ws
        self.session_id = session_id
        self.opened_by = opened_by
        self._send_lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        async with self._send_lock:
            if self.ws.client_state == WebSocketState.CONNECTED:
                await self.ws.send_text(json.dumps(payload))


class TerminalHub:
    def __init__(self):
        self._agents: dict[int, AgentLink] = {}

    # ── Agent side ──────────────────────────────────────────────────────
    def register_agent(self, link: AgentLink) -> None:
        existing = self._agents.get(link.node_id)
        if existing is not None:
            # A reconnect from the same node (agent restarted, network
            # blip) replaces the stale entry rather than stacking up —
            # only one control channel per node makes sense.
            log.info(f"replacing stale terminal control link for node {link.node_id}")
        self._agents[link.node_id] = link

    def unregister_agent(self, link: AgentLink) -> None:
        if self._agents.get(link.node_id) is link:
            del self._agents[link.node_id]

    def get_agent(self, node_id: int) -> Optional[AgentLink]:
        return self._agents.get(node_id)

    # ── Session lifecycle ───────────────────────────────────────────────
    async def start_session(
        self, node_id: int, browser_ws: WebSocket, opened_by: str, cols: int, rows: int
    ) -> tuple[Optional[AgentLink], Optional[BrowserLink], Optional[str]]:
        """Returns (agent_link, browser_link, error). error is set (and the
        other two None) if the node has no live control channel."""
        agent = self._agents.get(node_id)
        if agent is None:
            return None, None, "This node has no live terminal connection right now (agent offline or too old to support it — reinstall/upgrade the agent)."

        if agent.session_id is not None and agent.browser is not None:
            # Preempt rather than reject: a stuck/abandoned tab shouldn't
            # permanently block a legitimate reconnect from the same or
            # another admin.
            log.info(f"preempting active terminal session {agent.session_id} on node {node_id}")
            await agent.browser.send({"type": "status", "state": "exited", "message": "Another admin started a new terminal session on this node."})
            try:
                await agent.browser.ws.close()
            except Exception:
                pass
            await agent.send({"type": "stop", "session_id": agent.session_id})

        session_id = secrets.token_urlsafe(12)
        browser = BrowserLink(browser_ws, session_id, opened_by)
        agent.session_id = session_id
        agent.browser = browser
        await agent.send({"type": "start", "session_id": session_id, "cols": cols, "rows": rows})
        return agent, browser, None

    async def stop_session(self, agent: AgentLink) -> None:
        if agent.session_id is not None:
            await agent.send({"type": "stop", "session_id": agent.session_id})
        agent.session_id = None
        agent.browser = None

    # ── Message relay ───────────────────────────────────────────────────
    async def handle_agent_message(self, agent: AgentLink, msg: dict) -> None:
        if agent.browser is None or msg.get("session_id") != agent.session_id:
            return  # stale message for an already-closed session
        mtype = msg.get("type")
        if mtype == "started":
            await agent.browser.send({"type": "status", "state": "active"})
        elif mtype == "output":
            await agent.browser.send({"type": "output", "data": msg.get("data", "")})
        elif mtype == "exited":
            await agent.browser.send({"type": "status", "state": "exited", "message": f"Shell exited (code {msg.get('code', 0)})."})
            agent.session_id = None
            agent.browser = None
        elif mtype == "error":
            await agent.browser.send({"type": "status", "state": "error", "message": msg.get("message", "Unknown agent error")})
            agent.session_id = None
            agent.browser = None

    async def handle_browser_message(self, agent: AgentLink, msg: dict) -> None:
        if agent.session_id is None:
            return
        mtype = msg.get("type")
        if mtype == "input":
            await agent.send({"type": "input", "session_id": agent.session_id, "data": msg.get("data", "")})
        elif mtype == "resize":
            await agent.send({"type": "resize", "session_id": agent.session_id, "cols": msg.get("cols", 80), "rows": msg.get("rows", 24)})


hub = TerminalHub()
