-- pktNode SQLite initial migration
-- Manages: users, settings, nodes (managed endpoints), agent enrollment/auth,
-- inventory, metrics history, remote commands, alert rules, alert events

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ─────────────────────────────────────────────────────────────────────────────
-- Settings  (key/value store for all app configuration)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,         -- JSON-encoded value
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT NOT NULL UNIQUE,
    email             TEXT NOT NULL UNIQUE,
    hashed_password   TEXT,                   -- NULL for Okta-only users
    role              TEXT NOT NULL DEFAULT 'viewer'  -- admin | analyst | viewer
                        CHECK (role IN ('admin', 'analyst', 'viewer')),
    is_active         INTEGER NOT NULL DEFAULT 1,
    auth_provider     TEXT NOT NULL DEFAULT 'local', -- local | saml
    okta_sub          TEXT UNIQUE,            -- Okta subject claim for SSO users
    is_default_admin  INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_login        TEXT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- In-app log viewer: ring-buffered SQLite store
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_logs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    level    TEXT    NOT NULL,
    level_no INTEGER NOT NULL,
    logger   TEXT    NOT NULL,
    message  TEXT    NOT NULL,
    exc_info TEXT    NULL
);
CREATE INDEX IF NOT EXISTS idx_app_logs_ts       ON app_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_level_no ON app_logs (level_no);
CREATE INDEX IF NOT EXISTS idx_app_logs_logger   ON app_logs (logger);

-- ─────────────────────────────────────────────────────────────────────────────
-- Enrollment tokens — shared secrets handed to the agent installer at install
-- time. The agent exchanges one of these (one-time or multi-use) for its own
-- per-node agent_token during POST /api/agent/enroll, then never uses the
-- enrollment token again.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enrollment_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL DEFAULT '',
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT,
    max_uses     INTEGER,              -- NULL = unlimited
    use_count    INTEGER NOT NULL DEFAULT 0,
    revoked      INTEGER NOT NULL DEFAULT 0,
    revoked_at   TEXT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Nodes  (managed endpoints/assets — one row per enrolled agent)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nodes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_uuid          TEXT NOT NULL UNIQUE,     -- generated once by the agent, persisted locally
    hostname            TEXT NOT NULL,
    display_name        TEXT,
    os_type             TEXT NOT NULL,            -- darwin | windows | linux
    os_version          TEXT,
    arch                TEXT,
    agent_version       TEXT,
    enrollment_token_id INTEGER REFERENCES enrollment_tokens(id) ON DELETE SET NULL,
    status              TEXT NOT NULL DEFAULT 'pending',  -- pending | online | offline | stale | decommissioned
    ip_address          TEXT,
    serial_number       TEXT,
    manufacturer        TEXT,
    model               TEXT,
    cpu_model           TEXT,
    cpu_cores           INTEGER,
    memory_total_mb     INTEGER,
    disk_total_gb       REAL,
    disk_free_gb        REAL,
    uptime_seconds      INTEGER,
    timezone            TEXT,
    domain_or_workgroup TEXT,
    current_user        TEXT,
    tags_json           TEXT NOT NULL DEFAULT '[]',
    notes               TEXT NOT NULL DEFAULT '',
    is_active           INTEGER NOT NULL DEFAULT 1,
    first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_checkin_at     TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nodes_status   ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_hostname ON nodes(hostname);

-- Per-node bearer token used for every check-in after enrollment.
CREATE TABLE IF NOT EXISTS agent_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at  TEXT,
    revoked       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_node ON agent_tokens(node_id);

-- Installed software, replaced wholesale on each full inventory check-in.
CREATE TABLE IF NOT EXISTS node_software (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    version      TEXT,
    publisher    TEXT,
    install_date TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_software_node ON node_software(node_id);
CREATE INDEX IF NOT EXISTS idx_node_software_name ON node_software(name);

-- Latest running-process snapshot, replaced wholesale on each check-in
-- (not retained historically — this is a point-in-time view, not a log).
CREATE TABLE IF NOT EXISTS node_processes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    pid          INTEGER NOT NULL,
    name         TEXT NOT NULL,
    cpu_pct      REAL,
    mem_mb       REAL,
    username     TEXT,
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_processes_node ON node_processes(node_id);

-- Network interfaces, replaced wholesale on each check-in.
CREATE TABLE IF NOT EXISTS node_interfaces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    mac_address  TEXT,
    ip_addresses TEXT NOT NULL DEFAULT '[]',   -- JSON array
    is_up        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_node_interfaces_node ON node_interfaces(node_id);

-- Lightweight metrics time series for trend charts (CPU/mem/disk over time).
CREATE TABLE IF NOT EXISTS node_metrics_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    cpu_pct      REAL,
    mem_pct      REAL,
    disk_pct     REAL,
    recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_metrics_node_ts ON node_metrics_history(node_id, recorded_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Remote actions (RMM commands queued for an agent to pick up on its next
-- check-in and report a result for)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commands (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    command_type  TEXT NOT NULL,   -- restart_service | kill_process | run_script | reboot | shutdown
    payload_json  TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | running | completed | failed
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at       TEXT,
    completed_at  TEXT,
    exit_code     INTEGER,
    result_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_node_status ON commands(node_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Alert rules
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    rule_type       TEXT NOT NULL,   -- node_offline | disk_low | cpu_high | mem_high
    conditions      TEXT NOT NULL DEFAULT '{}',  -- JSON: type-specific params
    time_window_min INTEGER NOT NULL DEFAULT 5,
    severity        TEXT NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info','warning','critical')),
    channels        TEXT NOT NULL DEFAULT '["inapp"]',  -- JSON array of channel names
    cooldown_min    INTEGER NOT NULL DEFAULT 30,
    created_by      INTEGER REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired      TEXT
);

-- Built-in: alert when a node stops checking in
INSERT OR IGNORE INTO alert_rules (id, name, description, rule_type, conditions, severity, channels)
VALUES (1,
    'Node offline',
    'Fires when a node has not checked in within the configured offline threshold',
    'node_offline',
    '{}',
    'critical',
    '["inapp"]'
);

-- Built-in: alert when free disk space drops too low
INSERT OR IGNORE INTO alert_rules (id, name, description, rule_type, conditions, severity, channels)
VALUES (2,
    'Disk space low',
    'Fires when a node''s free disk space drops below the configured threshold',
    'disk_low',
    '{"threshold_pct": 10}',
    'warning',
    '["inapp"]'
);

-- Built-in: alert when CPU stays high
INSERT OR IGNORE INTO alert_rules (id, name, description, rule_type, conditions, severity, channels)
VALUES (3,
    'CPU usage high',
    'Fires when a node''s CPU usage stays above the configured threshold across the time window',
    'cpu_high',
    '{"threshold_pct": 90}',
    'warning',
    '["inapp"]'
);

-- Built-in: alert when memory stays high
INSERT OR IGNORE INTO alert_rules (id, name, description, rule_type, conditions, severity, channels)
VALUES (4,
    'Memory usage high',
    'Fires when a node''s memory usage stays above the configured threshold across the time window',
    'mem_high',
    '{"threshold_pct": 90}',
    'warning',
    '["inapp"]'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Alert events  (fired instances of alert rules)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id        INTEGER NOT NULL REFERENCES alert_rules(id),
    node_id        INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    severity       TEXT NOT NULL,
    message        TEXT NOT NULL,
    details        TEXT NOT NULL DEFAULT '{}',  -- JSON: extra context
    fired_at       TEXT NOT NULL DEFAULT (datetime('now')),
    acked_at       TEXT,
    acked_by       INTEGER REFERENCES users(id),
    resolved_at    TEXT,
    auto_resolved  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alert_events_fired    ON alert_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_acked    ON alert_events(acked_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule     ON alert_events(rule_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_resolved ON alert_events(resolved_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_node     ON alert_events(node_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Notification delivery log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES alert_events(id),
    channel     TEXT NOT NULL,    -- email | slack | pagerduty | webhook | inapp
    status      TEXT NOT NULL,    -- sent | failed | skipped
    error       TEXT,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_log_event ON notification_log(event_id);
