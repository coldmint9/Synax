/** Isolated version-store workers/fixtures must apply these in ledger order. */
export const VERSION_SCHEMA_MIGRATIONS = [
  "0051_conversation_version_core.sql",
  "0052_conversation_version_heads.sql",
  "0053_conversation_compact_versions.sql",
  "0054_conversation_checkpoint_index.sql",
] as const;
