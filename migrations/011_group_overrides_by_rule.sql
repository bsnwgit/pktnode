-- Group alert overrides now target a specific alert rule, not a rule type as
-- a whole — there can be more than one rule of the same type (e.g. two
-- disk_low rules at different severities/thresholds), and a type-wide
-- override couldn't distinguish between them.
CREATE TABLE group_alert_overrides_v2 (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name    TEXT NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    rule_id       INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    enabled       INTEGER,
    threshold_pct REAL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_name, rule_id)
);

-- Best-effort carry-over: only migrate a row when its rule_type maps to
-- exactly one existing alert rule. With more than one (or zero) matching
-- rules there's no way to know which one the override was meant for, so
-- it's dropped rather than guessed at.
INSERT INTO group_alert_overrides_v2 (group_name, rule_id, enabled, threshold_pct, created_at, updated_at)
SELECT o.group_name, r.id, o.enabled, o.threshold_pct, o.created_at, o.updated_at
FROM group_alert_overrides o
JOIN alert_rules r ON r.rule_type = o.rule_type
WHERE (SELECT COUNT(*) FROM alert_rules r2 WHERE r2.rule_type = o.rule_type) = 1;

DROP TABLE group_alert_overrides;
ALTER TABLE group_alert_overrides_v2 RENAME TO group_alert_overrides;
