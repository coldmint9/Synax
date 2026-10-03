CREATE INDEX IF NOT EXISTS idx_conversation_mutation_owner_cursor
 ON conversation_mutations(owner_session_id,sequence);
CREATE INDEX IF NOT EXISTS idx_conversation_mutation_open_cursor
 ON conversation_mutations(sequence) WHERE state='open';
