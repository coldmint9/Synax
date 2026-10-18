// E2E-only instrumentation: capture even swallowed reads of retired runtime tables.
const Database = require('libsql');
const fs = require('node:fs');
const retired = /\b(?:agent_runtime_\w+|conversation_\w+|jsonl_\w+|transcript_\w+|agent_plan_artifacts|terminal_sessions)\b/i;
for (const method of ['prepare', 'exec']) {
  const original = Database.prototype[method];
  Database.prototype[method] = function(sql, ...args) {
    const table = typeof sql === 'string' && sql.match(retired)?.[0];
    if (table && process.env.SYNAX_E2E_SQL_PROBE) {
      fs.appendFileSync(process.env.SYNAX_E2E_SQL_PROBE, JSON.stringify({ table, method, stack: new Error().stack }) + '\n');
    }
    return original.call(this, sql, ...args);
  };
}
