import fs from 'node:fs';
import path from 'node:path';
import { acquireRuntimeHost } from '../../runtime-host.js';
import { agentSessionRuntime } from '../../session-runtime.js';
import { agentRuntimeStore } from '../../session-store.js';
import { withinExecutionContext } from '../../../../lib/execution-context.js';
import { spawnOwnedProcess } from '../../owned-process.js';
const root = process.env.DATA_ROOT!;
const host = acquireRuntimeHost(root);
process.env.SYNAX_RUNTIME_HOST_ID = host.hostId;
process.env.SYNAX_RUNTIME_DATA_ROOT = root;
const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
const session = agentSessionRuntime.create({ projectId: 'crash-fixture', profileId: 'explorer', prompt: 'Controlled crash test', workDir: workspace });
const context = { sessionId: session.id, runId: 'crash-run', epoch: 'crash-epoch', hostId: host.hostId };
agentRuntimeStore.appendRun({ id: context.runId, sessionId: session.id, status: 'running', startedAt: new Date().toISOString(), completedAt: null,
  triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: { executionLease: { ...context, closed: false } } });
agentRuntimeStore.updateSession(session.id, { activeRunId: context.runId, status: 'running' });
for await (const child of withinExecutionContext(context, (async function* () {
  const marker = path.join(workspace, 'must-not-finish.txt');
  yield spawnOwnedProcess(process.execPath, ['-e', `process.on('SIGTERM',()=>{});console.log('running');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),10000);setInterval(()=>{},1000)`]);
})())) {
  child.stdout!.once('data', () => process.stdout.write(`${JSON.stringify({ ready: true, sessionId: session.id, pid: child.pid })}\n`));
}
setInterval(() => {}, 1000);
