-- Per-user external API keys (AbuseIPDB, ipinfo.io, IPQualityScore,
-- MXToolbox) for the future IP Info / Reputation Lookup feature. Each
-- authenticated user manages only their own keys, scoped by username —
-- no admin-wide view or override.
CREATE TABLE IF NOT EXISTS user_api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    provider    TEXT NOT NULL,
    api_key     TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (username, provider)
);
