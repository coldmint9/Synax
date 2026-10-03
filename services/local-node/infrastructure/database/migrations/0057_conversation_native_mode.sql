ALTER TABLE conversation_v3_heads ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'transcript'
 CHECK(runtime_mode IN ('transcript','native'));
