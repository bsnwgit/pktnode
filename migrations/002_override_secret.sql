-- Migration 002: per-node TOTP override secret for offline tamper-lockout.
-- Generated once at enrollment, never sent back to the agent again after
-- that — the agent already has it in its local config from enroll time.
ALTER TABLE nodes ADD COLUMN override_secret TEXT;
