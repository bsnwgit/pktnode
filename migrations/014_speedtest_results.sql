-- Speed test history — download/upload/latency measured via M-Lab's NDT7
-- protocol, run by the agent either on-demand (queued as an ordinary
-- run_speedtest command, see the commands table) or on a server-configured
-- interval (agent_speedtest_interval_sec in settings, 0 = disabled).
CREATE TABLE IF NOT EXISTS speedtest_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    status         TEXT NOT NULL,   -- completed | failed
    download_mbps  REAL,
    upload_mbps    REAL,
    latency_ms     REAL,
    jitter_ms      REAL,
    server_fqdn    TEXT,
    error          TEXT,
    triggered_by   TEXT NOT NULL,   -- manual | scheduled
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_speedtest_results_node ON speedtest_results(node_id, created_at);
