-- 0025_skill_platform.sql — Skill sources, installs, catalog (Phase 2)

CREATE TABLE IF NOT EXISTS skill_sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 60,
  read_only INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  last_sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_installs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  label TEXT,
  description TEXT NOT NULL,
  install_path TEXT NOT NULL,
  content_digest TEXT,
  applies_to_json TEXT NOT NULL DEFAULT '[]',
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'installed',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES skill_sources(id)
);

CREATE INDEX IF NOT EXISTS idx_skill_installs_source ON skill_installs(source_id);
CREATE INDEX IF NOT EXISTS idx_skill_installs_status ON skill_installs(status);

CREATE TABLE IF NOT EXISTS skill_catalog_entries (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT,
  remote_url TEXT NOT NULL,
  content_digest TEXT,
  install_count INTEGER,
  tags_json TEXT NOT NULL DEFAULT '[]',
  indexed_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES skill_sources(id)
);

CREATE INDEX IF NOT EXISTS idx_skill_catalog_source ON skill_catalog_entries(source_id);
CREATE INDEX IF NOT EXISTS idx_skill_catalog_name ON skill_catalog_entries(name);
