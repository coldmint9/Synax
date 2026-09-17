import Database from 'libsql';
import { cacheUsageSample, projectCacheUsage } from '../api/services/agent-runtime/cache-usage.js';
const db = new Database('/Users/mint/.synax/context.db', { readonly: true });
const rows = db.prepare('SELECT id, model, started_at, metadata_json FROM agent_runtime_run_steps WHERE session_id = ? ORDER BY started_at, step_index LIMIT 75').all('ars_3f438924a4f0488f94b92daafda35784') as Array<{id: string; model: string; started_at: string; metadata_json: string}>;
const result = projectCacheUsage(rows.map(row => {
  const metadata = JSON.parse(row.metadata_json);
  return cacheUsageSample({ stepId: row.id, measuredAt: row.started_at, model: row.model, unit: 'request' }, metadata.usage, { source: 'sdk', providerMetadata: metadata.providerMetadata });
}));
console.log(JSON.stringify({ session: result.session, latestRatio: result.latest?.ratio, recent: result.recent }, null, 2));
db.close();
