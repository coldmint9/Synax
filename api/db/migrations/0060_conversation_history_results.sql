CREATE TABLE conversation_v3_history_requests (
 session_id TEXT NOT NULL REFERENCES conversation_v3_heads(session_id) ON DELETE RESTRICT,
 request_id TEXT NOT NULL CHECK(length(CAST(request_id AS BLOB)) BETWEEN 1 AND 128),
 request_hash BLOB NOT NULL CHECK(typeof(request_hash)='blob' AND length(request_hash)=32),
 result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=1048576 AND json_valid(result_json)),
 PRIMARY KEY(session_id,request_id)
) WITHOUT ROWID;
CREATE TRIGGER conversation_v3_history_results_insert AFTER INSERT ON conversation_v3_history_requests BEGIN
 SELECT CASE WHEN (SELECT metadata_bytes+256+length(CAST(NEW.session_id AS BLOB))+length(CAST(NEW.request_id AS BLOB))+length(CAST(NEW.result_json AS BLOB))>metadata_limit FROM conversation_v3_storage WHERE id=1) THEN RAISE(ABORT,'VERSION_METADATA_BUDGET_EXCEEDED') END;
 UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes+256+length(CAST(NEW.session_id AS BLOB))+length(CAST(NEW.request_id AS BLOB))+length(CAST(NEW.result_json AS BLOB)) WHERE id=1;
END;
CREATE TRIGGER conversation_v3_history_results_delete AFTER DELETE ON conversation_v3_history_requests BEGIN
 UPDATE conversation_v3_storage SET metadata_bytes=metadata_bytes-256-length(CAST(OLD.session_id AS BLOB))-length(CAST(OLD.request_id AS BLOB))-length(CAST(OLD.result_json AS BLOB)) WHERE id=1;
END;
CREATE TRIGGER conversation_v3_history_results_immutable BEFORE UPDATE ON conversation_v3_history_requests BEGIN SELECT RAISE(ABORT,'VERSION_IMMUTABLE_OPERATION'); END;
