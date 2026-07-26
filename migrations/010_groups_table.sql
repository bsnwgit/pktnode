-- Groups become a real, explicitly-created entity — up to now a "group" was
-- just whatever string someone typed into a node's tags, created implicitly.
-- Group creation now only happens in Settings -> Groups; nodes.tags_json
-- still holds membership (a node can be in more than one), but the values
-- it's allowed to hold are constrained to what's in this table.
CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backfill: any tag already assigned to a node becomes a real group, so
-- existing membership doesn't silently break now that creation is gated.
INSERT OR IGNORE INTO groups (name)
SELECT DISTINCT je.value
FROM nodes, json_each(nodes.tags_json) je
WHERE je.value IS NOT NULL AND je.value != '';

-- Rebuild group_alert_overrides with a real FK to groups(name), so deleting
-- a group automatically cleans up whatever overrides it had.
CREATE TABLE group_alert_overrides_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name    TEXT NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    rule_type     TEXT NOT NULL CHECK (rule_type IN ('node_offline','disk_low','cpu_high','mem_high')),
    enabled       INTEGER,
    threshold_pct REAL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_name, rule_type)
);
INSERT INTO group_alert_overrides_new SELECT * FROM group_alert_overrides;
DROP TABLE group_alert_overrides;
ALTER TABLE group_alert_overrides_new RENAME TO group_alert_overrides;
