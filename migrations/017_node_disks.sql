-- Per-volume disk snapshot — current state only, replaced in full on every
-- full-inventory check-in. Mirrors node_interfaces/node_ports rather than
-- node_metrics_history: a device's set of volumes rarely changes, so there's
-- no value in keeping history, only the latest breakdown per mount point.
CREATE TABLE IF NOT EXISTS node_disks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    mount_point  TEXT NOT NULL,
    device       TEXT,
    fs_type      TEXT,
    total_gb     REAL,
    free_gb      REAL,
    used_pct     REAL
);
CREATE INDEX IF NOT EXISTS idx_node_disks_node ON node_disks(node_id);
