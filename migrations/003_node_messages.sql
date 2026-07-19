-- Two-way messaging between an admin (server UI) and the logged-in user on
-- a node (agent tray helper). Polling-based both directions, same pattern
-- as commands.
CREATE TABLE IF NOT EXISTS node_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    sender        TEXT NOT NULL,   -- admin | agent
    message       TEXT NOT NULL,
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at  TEXT             -- set once the tray has shown an admin->agent message
);
CREATE INDEX IF NOT EXISTS idx_node_messages_node ON node_messages(node_id, created_at);
