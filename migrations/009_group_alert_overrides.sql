-- Group-level alert overrides. A "group" is not a separate entity — it's
-- just a tag value out of nodes.tags_json, and a node can carry multiple
-- tags/groups at once. This table lets each (group, rule_type) pair force
-- an alert on/off and/or override its threshold_pct, independent of the
-- rule's own default and (for node_offline) the per-node override.
CREATE TABLE IF NOT EXISTS group_alert_overrides (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name    TEXT NOT NULL,
    rule_type     TEXT NOT NULL CHECK (rule_type IN ('node_offline','disk_low','cpu_high','mem_high')),
    enabled       INTEGER,        -- NULL = inherit; 0/1 = force this rule off/on for the group
    threshold_pct REAL,           -- NULL = inherit the rule's own threshold; n/a for node_offline
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_name, rule_type)
);
