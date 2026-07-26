-- Per-node override for the node_offline ("host down") alert. NULL = follow
-- the global alert_host_down_enabled setting; 1 = always alert for this node
-- regardless of the global setting; 0 = never alert for this node.
ALTER TABLE nodes ADD COLUMN alert_host_down_override INTEGER;
