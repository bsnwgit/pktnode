-- The tray chat feature (2-way admin<->agent messaging) was removed
-- entirely — server API, agent/tray code, and frontend UI all pulled out
-- together. Nothing else references this table.
DROP TABLE IF EXISTS node_messages;
