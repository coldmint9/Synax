import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import NativeDatabase from 'libsql';

/** A PID lock only refuses a second host; it never kills a process based on a stale PID. */
export function acquireRuntimeHost(dataRoot: string): { hostId: string; release(): void } {
  fs.mkdirSync(dataRoot, { recursive: true });
  const filename = path.join(dataRoot, 'context.db');
  const db = new NativeDatabase(filename);
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runtime_host_lock (id INTEGER PRIMARY KEY CHECK(id=1), host_id TEXT NOT NULL, pid INTEGER NOT NULL);');
  let hostId: string = randomUUID();
  try {
    db.exec('BEGIN IMMEDIATE');
    const previous = db.prepare('SELECT host_id, pid FROM runtime_host_lock WHERE id=1').get() as { host_id: string; pid: number } | undefined;
    if (previous && previous.pid !== process.pid) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive) throw new Error(`Runtime data is already owned by process ${previous.pid}. Stop that host before starting another.`);
    }
    if (previous?.pid === process.pid) hostId = previous.host_id;
    db.prepare('INSERT OR REPLACE INTO runtime_host_lock(id, host_id, pid) VALUES (1, ?, ?)').run(hostId, process.pid);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
  return { hostId, release() {
    const connection = new NativeDatabase(filename);
    try { connection.prepare('DELETE FROM runtime_host_lock WHERE id=1 AND host_id=? AND pid=?').run(hostId, process.pid); }
    finally { connection.close(); }
  } };
}
