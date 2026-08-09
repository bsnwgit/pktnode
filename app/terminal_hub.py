"""
Live remote terminal + file transfer relay.

The agent keeps one persistent outbound WebSocket open to this server as
a control channel — separate from, and in addition to, its periodic HTTP
check-in. An admin's browser opens a second WebSocket to this server when
it wants a shell or a file browser. This module holds the in-memory
registry of both sides and relays JSON-framed messages between them.

Terminal and file transfer are two independent sessions multiplexed over
the *same* control-channel connection: an AgentLink has one slot for a
terminal session and a separate slot for a file session, so an admin can
have Live Terminal and File Transfer open on the same node at once. Each
kind is still capped at one active session per node at a time (opening a
second terminal, or a second file session, preempts the first) — same
policy the terminal side already had, just no longer shared across kinds.

The managed node never accepts an inbound connection of any kind: the
agent always dials out, exactly like its check-ins, so neither feature
needs any firewall changes on the node's end.

Single-process, in-memory registry — correct for pktNode's one-uvicorn-
worker deployment. Scaling to multiple server processes would need an
external broker (e.g. redis pub/sub) instead of the plain dicts below.

Wire protocol (JSON text frames both directions):

  Server -> Agent (control channel), terminal:
    {"type": "start",  "session_id": str, "cols": int, "rows": int}
    {"type": "input",  "session_id": str, "data": "<base64>"}
    {"type": "resize", "session_id": str, "cols": int, "rows": int}
    {"type": "stop",   "session_id": str}

  Agent -> Server (control channel), terminal:
    {"type": "started", "session_id": str}
    {"type": "output",  "session_id": str, "data": "<base64>"}
    {"type": "exited",  "session_id": str, "code": int}
    {"type": "error",   "session_id": str, "message": str}

  Server -> Browser (session channel), terminal — session_id stripped,
  browser only ever has the one session it opened:
    {"type": "status", "state": "connecting"|"active"|"exited"|"error", "message": str}
    {"type": "output", "data": "<base64>"}

  Browser -> Server (session channel), terminal:
    {"type": "input",  "data": "<base64>"}
    {"type": "resize", "cols": int, "rows": int}

  File transfer wire protocol lives in the same JSON-frame channel, with
  every type prefixed "file_" so it can be told apart from the terminal
  messages above on the shared agent connection — see FileHub below.
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
        # Independent slot for a file-transfer session — see module
        # docstring on why this is separate from the terminal slot above.
        self.file_session_id: Optional[str] = None
        self.file_browser: Optional["BrowserLink"] = None

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


class FileHub:
    """Same relay pattern as TerminalHub, for the file-transfer session
    slot (AgentLink.file_session_id / .file_browser) instead of the
    terminal one. Kept as a separate class rather than folded into
    TerminalHub so each protocol's message handling stays simple to read,
    even though the two share the underlying AgentLink connection.

    Wire protocol (JSON text frames, all types prefixed "file_"):

      Server -> Agent (control channel):
        {"type": "file_start",  "session_id": str}
        {"type": "file_list",   "session_id": str, "path": str}
        {"type": "file_download", "session_id": str, "path": str}
        {"type": "file_upload_start", "session_id": str, "path": str, "new_name": str, "size": int}
        {"type": "file_upload_chunk", "session_id": str, "data": "<base64>"}
        {"type": "file_upload_end",   "session_id": str}
        {"type": "file_mkdir",  "session_id": str, "path": str, "new_name": str}
        {"type": "file_delete", "session_id": str, "path": str}
        {"type": "file_rename", "session_id": str, "path": str, "new_name": str}
        {"type": "file_stop",   "session_id": str}

      Agent -> Server (control channel):
        {"type": "file_ready",       "session_id": str, "roots": [str], "home": str}
        {"type": "file_list_result", "session_id": str, "path": str, "entries": [dict]}
        {"type": "file_chunk",       "session_id": str, "data": "<base64>"}
        {"type": "file_download_done", "session_id": str}
        {"type": "file_upload_done",   "session_id": str}
        {"type": "file_op_result", "session_id": str, "op": str, "ok": bool, "message": str}
        {"type": "file_error",     "session_id": str, "message": str}

      Server -> Browser (session channel) — session_id stripped:
        {"type": "status", "state": "connecting"|"active"|"exited"|"error", "message": str}
        {"type": "ready", "roots": [str], "home": str}
        {"type": "list_result", "path": str, "entries": [dict]}
        {"type": "chunk", "data": "<base64>"}
        {"type": "download_done"}
        {"type": "upload_done"}
        {"type": "op_result", "op": str, "ok": bool, "message": str}

      Browser -> Server (session channel):
        {"type": "list", "path": str}
        {"type": "download", "path": str}
        {"type": "upload_start", "path": str, "new_name": str, "size": int}
        {"type": "upload_chunk", "data": "<base64>"}
        {"type": "upload_end"}
        {"type": "mkdir", "path": str, "new_name": str}
        {"type": "delete", "path": str}
        {"type": "rename", "path": str, "new_name": str}
    """

    def __init__(self):
        # No separate agent registry — reuses the same AgentLink objects
        # TerminalHub's register_agent/unregister_agent already track.
        self._agents = hub._agents

    def get_agent(self, node_id: int) -> Optional[AgentLink]:
        return self._agents.get(node_id)

    async def start_session(
        self, node_id: int, browser_ws: WebSocket, opened_by: str
    ) -> tuple[Optional[AgentLink], Optional["BrowserLink"], Optional[str]]:
        agent = self._agents.get(node_id)
        if agent is None:
            return None, None, "This node has no live connection right now (agent offline or too old to support file transfer — reinstall/upgrade the agent)."

        if agent.file_session_id is not None and agent.file_browser is not None:
            log.info(f"preempting active file session {agent.file_session_id} on node {node_id}")
            await agent.file_browser.send({"type": "status", "state": "exited", "message": "Another admin started a new file transfer session on this node."})
            try:
                await agent.file_browser.ws.close()
            except Exception:
                pass
            await agent.send({"type": "file_stop", "session_id": agent.file_session_id})

        session_id = secrets.token_urlsafe(12)
        browser = BrowserLink(browser_ws, session_id, opened_by)
        agent.file_session_id = session_id
        agent.file_browser = browser
        await agent.send({"type": "file_start", "session_id": session_id})
        return agent, browser, None

    async def stop_session(self, agent: AgentLink) -> None:
        if agent.file_session_id is not None:
            await agent.send({"type": "file_stop", "session_id": agent.file_session_id})
        agent.file_session_id = None
        agent.file_browser = None

    async def handle_agent_message(self, agent: AgentLink, msg: dict) -> None:
        if agent.file_browser is None or msg.get("session_id") != agent.file_session_id:
            return  # stale message for an already-closed session
        mtype = msg.get("type")
        if mtype == "file_ready":
            await agent.file_browser.send({"type": "ready", "roots": msg.get("roots", []), "home": msg.get("home", "")})
        elif mtype == "file_list_result":
            await agent.file_browser.send({"type": "list_result", "path": msg.get("path", ""), "entries": msg.get("entries", [])})
        elif mtype == "file_chunk":
            await agent.file_browser.send({"type": "chunk", "data": msg.get("data", "")})
        elif mtype == "file_download_done":
            await agent.file_browser.send({"type": "download_done"})
        elif mtype == "file_upload_done":
            await agent.file_browser.send({"type": "upload_done"})
        elif mtype == "file_op_result":
            await agent.file_browser.send({"type": "op_result", "op": msg.get("op", ""), "ok": bool(msg.get("ok")), "message": msg.get("message", "")})
        elif mtype == "file_error":
            await agent.file_browser.send({"type": "op_result", "op": msg.get("op", ""), "ok": False, "message": msg.get("message", "Unknown agent error")})

    async def handle_browser_message(self, agent: AgentLink, msg: dict) -> None:
        if agent.file_session_id is None:
            return
        sid = agent.file_session_id
        mtype = msg.get("type")
        if mtype == "list":
            await agent.send({"type": "file_list", "session_id": sid, "path": msg.get("path", "")})
        elif mtype == "download":
            await agent.send({"type": "file_download", "session_id": sid, "path": msg.get("path", "")})
        elif mtype == "upload_start":
            await agent.send({"type": "file_upload_start", "session_id": sid, "path": msg.get("path", ""), "new_name": msg.get("new_name", ""), "size": msg.get("size", 0)})
        elif mtype == "upload_chunk":
            await agent.send({"type": "file_upload_chunk", "session_id": sid, "data": msg.get("data", "")})
        elif mtype == "upload_end":
            await agent.send({"type": "file_upload_end", "session_id": sid})
        elif mtype == "mkdir":
            await agent.send({"type": "file_mkdir", "session_id": sid, "path": msg.get("path", ""), "new_name": msg.get("new_name", "")})
        elif mtype == "delete":
            await agent.send({"type": "file_delete", "session_id": sid, "path": msg.get("path", "")})
        elif mtype == "rename":
            await agent.send({"type": "file_rename", "session_id": sid, "path": msg.get("path", ""), "new_name": msg.get("new_name", "")})


file_hub = FileHub()
