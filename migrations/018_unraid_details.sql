-- Unraid-specific inventory — array/parity health, per-disk array roster,
-- Docker containers, and VMs. Only ever populated for nodes where
-- os_type='unraid'; empty/absent for every other platform. Current-state
-- snapshots (replaced in full on each full-inventory check-in), same
-- pattern as node_interfaces/node_ports/node_disks — no history kept.
CREATE TABLE IF NOT EXISTS node_unraid_array (
    node_id                 INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    state                   TEXT,     -- mdState: STARTED | STOPPED | ...
    parity_check_active     INTEGER NOT NULL DEFAULT 0,
    parity_check_pct        REAL,
    parity_check_errors     INTEGER,
    last_sync_at            TEXT,     -- null if the array has never been synced
    last_sync_errors        INTEGER
);

CREATE TABLE IF NOT EXISTS node_unraid_disks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,   -- parity | disk1 | cache | local | ...
    role       TEXT,            -- Parity | Data | Cache | Flash
    device     TEXT,
    status     TEXT,            -- DISK_OK | DISK_NP | ...
    temp_c     REAL,
    size_gb    REAL,
    fs_type    TEXT,
    num_errors INTEGER
);
CREATE INDEX IF NOT EXISTS idx_node_unraid_disks_node ON node_unraid_disks(node_id);

CREATE TABLE IF NOT EXISTS node_unraid_containers (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    image   TEXT,
    state   TEXT,   -- running | exited | ...
    status  TEXT    -- docker's human-readable status text, e.g. "Up 9 days"
);
CREATE INDEX IF NOT EXISTS idx_node_unraid_containers_node ON node_unraid_containers(node_id);

CREATE TABLE IF NOT EXISTS node_unraid_vms (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    state   TEXT   -- running | shut off | paused | ...
);
CREATE INDEX IF NOT EXISTS idx_node_unraid_vms_node ON node_unraid_vms(node_id);
