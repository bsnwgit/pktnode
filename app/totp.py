"""
RFC 6238 TOTP (6-digit, SHA-1, 30-second step) — no external dependency.

This is the offline tamper-lockout override code: the agent is issued a
secret once at enrollment and never talks to the server to check a code —
it derives the same code independently from the secret + its own clock.
Must stay byte-for-byte compatible with the agent's implementation in
agent/internal/totp/totp.go (cross-verified against known secret/timestamp
pairs in that package's tests).
"""
from __future__ import annotations

import base64
import hmac
import os
import secrets
import struct
import time
from hashlib import sha1

_STEP_SECONDS = 30
_DIGITS = 6


def generate_secret() -> str:
    """Random base32 secret (160 bits), no padding."""
    return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")


def _code(secret: str, counter: int) -> str:
    key = base64.b32decode(_pad(secret.upper()))
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, sha1).digest()
    offset = digest[-1] & 0x0F
    truncated = (
        ((digest[offset] & 0x7F) << 24)
        | (digest[offset + 1] << 16)
        | (digest[offset + 2] << 8)
        | digest[offset + 3]
    )
    return str(truncated % (10**_DIGITS)).zfill(_DIGITS)


def _pad(secret: str) -> str:
    return secret + "=" * ((8 - len(secret) % 8) % 8)


def current_code(secret: str, at: float | None = None) -> str:
    ts = at if at is not None else time.time()
    return _code(secret, int(ts) // _STEP_SECONDS)


def seconds_remaining(at: float | None = None) -> int:
    ts = at if at is not None else time.time()
    return _STEP_SECONDS - (int(ts) % _STEP_SECONDS)


def verify(secret: str, candidate: str) -> bool:
    """Accepts the current time step and one step on either side (±30s)
    to tolerate clock skew, same as the agent's Verify()."""
    candidate = candidate.strip()
    if len(candidate) != _DIGITS:
        return False
    now_counter = int(time.time()) // _STEP_SECONDS
    for delta in (0, -1, 1):
        expected = _code(secret, now_counter + delta)
        if secrets.compare_digest(expected, candidate):
            return True
    return False
