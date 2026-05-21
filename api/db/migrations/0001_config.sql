-- ---------------------------------------------------------------------------
-- 0001_config.sql — 两级配置表（Global + Project）
--
-- 设计要点：
--   - global_config  单行表（通过 id 约束保证只有一条记录）
--   - project_config 每个项目一行，project_id 唯一
--   - JSON 字段使用 TEXT 存储（SQLite 无原生 JSON 类型）
--   - 幂等 DDL（IF NOT EXISTS）
-- ---------------------------------------------------------------------------

-- 全局配置表（系统级，单例）
CREATE TABLE IF NOT EXISTS global_config (
  id              INTEGER PRIMARY KEY CHECK(id = 1),   -- 强制单行
  version         INTEGER NOT NULL DEFAULT 1,
  config_json     TEXT NOT NULL,                       -- 完整 GlobalConfig JSON
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL
);

-- 项目级配置表
CREATE TABLE IF NOT EXISTS project_config (
  project_id      TEXT PRIMARY KEY,
  version         INTEGER NOT NULL DEFAULT 1,
  config_json     TEXT NOT NULL,                       -- 完整 ProjectConfig JSON
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL
);
