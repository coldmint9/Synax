CREATE TABLE IF NOT EXISTS media_jobs (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 provider_id TEXT NOT NULL,
 model_id TEXT NOT NULL,
 operation TEXT NOT NULL,
 input_json TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','submitting','running','downloading','succeeded','failed','cancelled','unknown')),
 upstream_id TEXT,
 result_asset_ids_json TEXT NOT NULL DEFAULT '[]',
 error_code TEXT,
 error TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_media_jobs_pending ON media_jobs(status, lease_until, created_at);
CREATE INDEX IF NOT EXISTS idx_media_jobs_session ON media_jobs(session_id, created_at);
