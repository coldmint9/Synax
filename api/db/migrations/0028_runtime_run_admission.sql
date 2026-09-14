-- Keep admission identity on the existing Run rather than adding another task ledger.
CREATE UNIQUE INDEX IF NOT EXISTS idx_arr_runtime_request
ON agent_runtime_runs(session_id, json_extract(metadata_json, '$.runtime.requestId'))
WHERE json_extract(metadata_json, '$.runtime.requestId') IS NOT NULL;
