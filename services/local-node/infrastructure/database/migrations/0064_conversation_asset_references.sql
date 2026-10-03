-- Binding records, messages and tool records retain external media directly.
-- Each immutable object has at most ten links, so its delete cascade is bounded.
CREATE TABLE conversation_v3_asset_refs (
 object_hash BLOB NOT NULL REFERENCES conversation_v3_objects(hash) ON DELETE CASCADE
   CHECK(typeof(object_hash)='blob' AND length(object_hash)=32),
 asset_id TEXT NOT NULL REFERENCES agent_runtime_assets(id) ON DELETE RESTRICT,
 PRIMARY KEY(object_hash,asset_id)
) WITHOUT ROWID;
CREATE INDEX idx_conversation_v3_asset_refs_asset ON conversation_v3_asset_refs(asset_id);
CREATE TRIGGER conversation_v3_asset_ref_insert AFTER INSERT ON conversation_v3_asset_refs BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM conversation_v3_asset_refs WHERE object_hash=NEW.object_hash)>10 THEN RAISE(ABORT,'VERSION_ASSET_REF_LIMIT') END;
 SELECT CASE WHEN (SELECT metadata_bytes+128+length(CAST(NEW.asset_id AS BLOB))>metadata_limit FROM conversation_v3_storage WHERE id=1) THEN RAISE(ABORT,'VERSION_METADATA_BUDGET_EXCEEDED') END;
 UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes+128+length(CAST(NEW.asset_id AS BLOB)) WHERE id=1;
END;
CREATE TRIGGER conversation_v3_asset_ref_delete AFTER DELETE ON conversation_v3_asset_refs BEGIN
 UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes-128-length(CAST(OLD.asset_id AS BLOB)) WHERE id=1;
END;
CREATE TRIGGER conversation_v3_asset_ref_immutable BEFORE UPDATE ON conversation_v3_asset_refs BEGIN
 SELECT RAISE(ABORT,'VERSION_IMMUTABLE_ASSET_REF'); END;
