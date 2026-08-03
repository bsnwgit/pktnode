-- Host security signals from the agent: listening ports (feeds pktSecurity's
-- exposed-service risk scoring, which already reacts to asset_services rows
-- with zero pktSecurity-side changes) and a best-effort host firewall state.

ALTER TABLE nodes ADD COLUMN firewall_status TEXT NOT NULL DEFAULT 'unknown';

-- Listening ports, replaced wholesale on each full inventory check-in —
-- same lifecycle as node_software/node_processes/node_interfaces.
CREATE TABLE IF NOT EXISTS node_ports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    protocol     TEXT NOT NULL,
    port         INTEGER NOT NULL,
    process_name TEXT,
    pid          INTEGER,
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_ports_node ON node_ports(node_id);
