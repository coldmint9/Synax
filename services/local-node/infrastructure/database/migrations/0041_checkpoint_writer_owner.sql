-- A crashed writer must not leave a workspace lease open forever.
ALTER TABLE conversation_mutations ADD COLUMN owner_pid INTEGER;
CREATE TABLE IF NOT EXISTS conversation_snapshot_leases (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_pid INTEGER NOT NULL
);
