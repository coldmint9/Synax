/**
 * Replay data has two storage generations during the migration:
 *
 * - SQLite cursors below FILE_REPLAY_BASE for existing sessions;
 * - SessionLog cursors at or above FILE_REPLAY_BASE for new writes.
 *
 * Keep the mode decision in one place so a new producer cannot accidentally
 * bypass the file-backed writer in production.
 */
export const FILE_REPLAY_BASE = 2 ** 40;

export function fileBackedReplayEnabled(): boolean {
  return Boolean(process.env.SYNAX_STORAGE_OWNER_ENDPOINT) &&
    process.env.SYNAX_DISABLE_FILE_REPLAY !== "1";
}
