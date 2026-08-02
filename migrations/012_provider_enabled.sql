-- Per-provider preference: show this provider's section in the IP Lookup
-- modal at all (ipinfo/ipapi_is/abuseipdb/mxtoolbox). No row yet means never
-- configured/toggled, which defaults to shown.
ALTER TABLE user_api_keys ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
