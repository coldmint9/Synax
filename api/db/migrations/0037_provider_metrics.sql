-- Each physical model request has one durable ledger entry. Replayed runtime
-- events never write here; samples are captured at the wire boundary only.
CREATE TABLE IF NOT EXISTS provider_metric_fields (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  aggregation TEXT NOT NULL DEFAULT 'latest',
  visible INTEGER NOT NULL DEFAULT 0,
  accumulate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_metric_fields_provider ON provider_metric_fields(provider_id);
CREATE TABLE IF NOT EXISTS provider_metric_requests (
  provider_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  PRIMARY KEY(provider_id, request_id)
);
CREATE TABLE IF NOT EXISTS provider_metric_samples (
  field_id TEXT NOT NULL REFERENCES provider_metric_fields(id),
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL,
  number_value REAL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(field_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_metric_samples_session ON provider_metric_samples(session_id, field_id);
