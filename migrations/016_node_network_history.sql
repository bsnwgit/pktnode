-- Network throughput history — aggregate send/receive rate across all
-- non-loopback interfaces, sampled every check-in (same cadence as CPU/
-- mem/disk in node_metrics_history). Kept as its own table since it's a
-- rate derived from a delta between two check-ins, not a point-in-time
-- percent, and is null on an agent's first check-in after every restart
-- (no prior sample to diff against yet).
CREATE TABLE IF NOT EXISTS node_network_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    sent_mbps    REAL,
    recv_mbps    REAL,
    recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_network_node_ts ON node_network_history(node_id, recorded_at);
