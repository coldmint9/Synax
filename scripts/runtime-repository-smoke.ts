import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../services/local-node/modules/agent-runtime/contracts.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-rust-repository-'));
process.env.DATA_ROOT = root;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
const { RustRuntimeSupervisor } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const { AgentRuntimeStore } = await import('../services/local-node/modules/agent-runtime/session-store.js');
let supervisor = new RustRuntimeSupervisor({ dataRoot: root });
try {
  await supervisor.start();
  const store = new AgentRuntimeStore();
  const session: AgentSession = {
    id: 's', projectId: 'p', parentSessionId: null, childSessionIds: [], nodeId: null, profileId: 'synax',
    status: 'completed', title: 'Rust repository', prompt: 'retain records', contextSnapshotId: null,
    thinkingMode: 'standard', reasoningEffort: null, permissionRules: [], createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
    completedAt: null, resultSummary: null, blockedReason: null, skillIds: [], mcpServerIds: [], activeRunId: null, pendingResumeToken: null, sessionMetadata: {},
  };
  store.createSession(session);
  store.appendRun({ id:'r',sessionId:'s',status:'completed',startedAt:session.createdAt,completedAt:session.updatedAt,triggerMessageId:null,currentStep:1,stopReason:null,model:null,metadata:{} });
  store.appendMessage({ id:'m',sessionId:'s',runId:'r',stepId:null,role:'assistant',content:'Rust 中的消息 🚀',metadata:{},createdAt:session.createdAt });
  store.saveContextBundle({ id:'context',sessionId:'s',projectId:'p',nodeId:null,profileId:'synax',blocks:[],citations:[],warnings:[],createdAt:session.createdAt });
  store.updateSession('s',{contextSnapshotId:'context'});
  store.saveThinkingSummary({ id:'thinking',sessionId:'s',mode:'standard',framing:'retain reasoning',evidenceUsed:[],decision:'done',assumptions:[],risks:[],nextSteps:[] });
  store.saveCompactionRecord({id:'compact',sessionId:'s',runId:'r',summaryText:'durable summary',compressedMessageCount:1,originalTokenCount:50,compressedTokenCount:10,createdAt:session.createdAt});
  store.saveRecord('work',{id:'w',sessionId:'s',status:'completed',objective:'migration'});
  store.saveRecord('plan',{id:'plan',sessionId:'s',revision:1,title:'native plan'});
  assert.throws(()=>store.transaction(()=>{
    store.updateSession('s',{title:'must roll back'});
    store.appendMessage({id:'aborted',sessionId:'s',runId:null,stepId:null,role:'user',content:'must not persist',metadata:{},createdAt:session.createdAt});
    throw new Error('cancel local mutation');
  }),/cancel local mutation/);
  assert.equal(store.getSession('s').title,'Rust repository');
  assert.equal(store.getMessage('s','aborted'),undefined);
  await store.flush();
  assert.equal(existsSync(path.join(root,'context.db')),false,'repository must not open SQLite');
  await supervisor.stop();
  supervisor = new RustRuntimeSupervisor({dataRoot:root});
  await supervisor.start();
  const reopened = new AgentRuntimeStore();
  await reopened.hydrateSession('s');
  assert.equal(reopened.getSession('s').title,'Rust repository');
  assert.equal(reopened.listMessages('s')[0].content,'Rust 中的消息 🚀');
  assert.equal(reopened.getRun('r').status,'completed');
  assert.equal(reopened.getContextBundle('context').sessionId,'s');
  assert.equal(reopened.getThinkingSummary('thinking').decision,'done');
  assert.equal(reopened.getLatestCompactionRecord('s')?.summaryText,'durable summary');
  assert.equal(reopened.getRecord<{id:string;title:string}>('plan','plan')?.title,'native plan');
  assert.equal(reopened.getRecord<{id:string;objective:string}>('work','w')?.objective,'migration');
  assert.equal(reopened.getMessage('s','aborted'),undefined);
  assert.equal(existsSync(path.join(root,'context.db')),false);
  console.log('Rust repository smoke passed: session/entities/work/plan survive restart; local rollback publishes nothing; no SQLite file.');
} finally { await supervisor.stop(); await rm(root,{recursive:true,force:true}); }
