-- Runtime stream replay is authoritative in the Rust sidecar. The old SQLite
-- ring is intentionally removed after the offline migration/purge boundary.
DROP TABLE IF EXISTS agent_runtime_stream_records;
