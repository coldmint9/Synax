CREATE TABLE IF NOT EXISTS project_extensions (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'skill', 'mcp')),
  extension_id TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, extension_id)
);
CREATE TABLE IF NOT EXISTS extension_definitions (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'skill', 'mcp')),
  extension_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, extension_id)
);
CREATE TABLE IF NOT EXISTS extension_source_settings (
  project_id TEXT PRIMARY KEY,
  directories_json TEXT NOT NULL DEFAULT '[]'
);
-- New market installs are packages, not globally mounted legacy skills.
CREATE TABLE IF NOT EXISTS extension_skill_packages (
  install_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS extension_remote_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  catalog_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
