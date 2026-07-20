-- Whether the node's status-icon tray helper is actually installed —
-- reported by the agent on check-in. False for headless Linux by design,
-- and for Linux generally until a tray build ships. The UI uses this to
-- warn against messaging a node that has no way to ever show it.
ALTER TABLE nodes ADD COLUMN has_tray INTEGER NOT NULL DEFAULT 0;
