-- An absent legacy checkpoint table must not imply that v3 file history is dead.
ALTER TABLE conversation_v3_heads ADD COLUMN file_retention_floor INTEGER
 CHECK(file_retention_floor IS NULL OR file_retention_floor BETWEEN 0 AND 9007199254740991);
-- Draft v3 checkpoints predate this projection. Keep their file evidence rather
-- than attempting a destructive inference from immutable object payloads here.
UPDATE conversation_v3_heads SET file_retention_floor=0 WHERE checkpoint_root IS NOT NULL;
CREATE INDEX idx_conversation_v3_file_floor ON conversation_v3_heads(file_retention_floor)
 WHERE checkpoint_root IS NOT NULL;
