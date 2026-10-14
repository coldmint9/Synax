import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let close: (() => void) | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-jsonl-history-'));
  vi.stubEnv('DATA_ROOT', root); vi.stubEnv('SYNAX_TRANSCRIPT_STORAGE', 'jsonl'); vi.stubEnv('LOG_LEVEL', 'error');
  vi.resetModules();
});
afterEach(() => { close?.(); fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function setup() {
  const database = await import('../../../infrastructure/database/index.js'); close = database.closeDb;
  const { resetAgentRuntimeFixtures, plannerSessionInput } = await import('./agent-runtime-fixtures.js');
  resetAgentRuntimeFixtures();
  const { agentSessionRuntime } = await import('../session-runtime.js');
  const { agentRuntimeStore } = await import('../session-store.js');
  const bridge = await import('../checkpoints/version-runtime/bridge.js');
  const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root });
  agentRuntimeStore.updateSession(session.id, { status: 'completed' });
  return { db: database.getRawSqlite(), session, store: agentRuntimeStore, repo: bridge.versionRepository(), bridge };
}
function message(sessionId: string, id: string, role: 'user' | 'assistant' = 'assistant', content = id) {
  return { id, sessionId, role, content, metadata: {}, createdAt: new Date().toISOString(), runId: null, stepId: null };
}
function makeLegacy(db: Awaited<ReturnType<typeof setup>>['db'], id: string) {
  db.prepare('DELETE FROM session_history_storage WHERE session_id=?').run(id);
  db.prepare('DELETE FROM conversation_v3_owned_versions WHERE session_id=?').run(id);
  db.prepare('DELETE FROM conversation_v3_heads WHERE session_id=?').run(id);
}
describe('JSONL full conversation history', () => {
  it('creates JSONL-backed history and rolls back beyond 128 checkpoints without copying later messages', async () => {
    const { db, session, store, repo } = await setup();
    expect(db.prepare('SELECT full_history FROM conversation_v3_heads WHERE session_id=?').get(session.id)).toMatchObject({ full_history: 1 });
    let first = '';
    for (let i = 0; i < 140; i++) {
      store.appendMessage(message(session.id, `m${i}`, 'assistant', `reply-${i}`));
      const cp = repo.capture(session.id, 'reply', `m${i}`, null, 0);
      if (!i) first = cp.id;
    }
    const { checkpointSummary, applyHistory } = await import('../checkpoints/operations.js');
    expect(checkpointSummary(session.id, ['m0']).checkpoints[0].id).toBe(first);
    const before = Number((db.prepare('SELECT sum(committed_bytes) AS n FROM jsonl_payload_segments').get() as { n: number }).n);
    await applyHistory(session.id, { checkpointId: first, revision: repo.head(session.id).revision, requestId: 'oldest', action: 'rollback', includeFiles: false });
    expect(store.listMessages(session.id).map(m => m.id)).toEqual(['m0']);
    store.appendMessage(message(session.id, 'branch'));
    repo.capture(session.id, 'reply', 'branch', null, 0);
    expect(store.listMessages(session.id).map(m => m.id)).toEqual(['m0','branch']);
    expect(Number((db.prepare('SELECT sum(committed_bytes) AS n FROM jsonl_payload_segments').get() as { n: number }).n)).toBeGreaterThan(before);
    expect((db.prepare('SELECT count(*) AS n FROM conversation_v3_objects WHERE jsonl_payload=1').get() as { n: number }).n).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(root, 'version-jsonl', 'transcripts')).every(name => name.endsWith('.jsonl'))).toBe(true);
  }, 120000);

  it('migrates old JSONL messages, preserves their content, and reconstructs every input/reply boundary', async () => {
    const { db, session, store, repo } = await setup(); makeLegacy(db, session.id);
    const { transcriptRepository } = await import('../transcript-repository.js');
    transcriptRepository.appendJsonl(message(session.id, 'u1', 'user', 'question'));
    transcriptRepository.appendJsonl(message(session.id, 'a1', 'assistant', 'answer'));
    transcriptRepository.appendJsonl(message(session.id, 'u2', 'user', 'next'));
    transcriptRepository.appendJsonl(message(session.id, 'a2', 'assistant', 'later'));
    const { migrateJsonlSession } = await import('../checkpoints/version-runtime/jsonl-migration.js');
    const result = await migrateJsonlSession(session.id);
    expect(result).toMatchObject({ migrated: true, messages: 4, checkpoints: 4 });
    expect(store.listMessages(session.id).map(m => m.content)).toEqual(['question','answer','next','later']);
    const cp = repo.checkpointForMessage(session.id, 'reply', 'a1')!;
    expect(cp.payload.transcriptOnly).toBe(true);
    const { applyHistory } = await import('../checkpoints/operations.js');
    await expect(applyHistory(session.id, { action: 'rollback', checkpointId: cp.id, revision: repo.head(session.id).revision, requestId: 'unsafe-files', includeFiles: true })).rejects.toMatchObject({ code: 'HISTORY_FILES_UNAVAILABLE' });
    await applyHistory(session.id, { action: 'rollback', checkpointId: cp.id, revision: repo.head(session.id).revision, requestId: 'safe', includeFiles: false });
    expect(store.listMessages(session.id).map(m => m.id)).toEqual(['u1','a1']);
    expect((db.prepare('SELECT count(*) AS n FROM transcript_records WHERE session_id=?').get(session.id) as { n: number }).n).toBe(4);
  }, 60000);

  it('resumes at a durable migration page and fences writes until publication', async () => {
    const { db, session, store } = await setup(); makeLegacy(db, session.id);
    const { transcriptRepository } = await import('../transcript-repository.js');
    for (let n = 0; n < 20; n++) transcriptRepository.appendJsonl(message(session.id, `old${n}`));
    const { migrateJsonlSession } = await import('../checkpoints/version-runtime/jsonl-migration.js');
    await expect(migrateJsonlSession(session.id, { maxPages: 1 })).rejects.toMatchObject({ code: 'JSONL_MIGRATION_PAUSED' });
    expect(() => db.prepare('UPDATE agent_runtime_sessions SET title=? WHERE id=?').run('changed', session.id)).toThrow('JSONL_HISTORY_MIGRATION_BUSY');
    expect((db.prepare('SELECT copied_count FROM jsonl_history_migrations WHERE session_id=?').get(session.id) as { copied_count: number }).copied_count).toBe(16);
    expect(await migrateJsonlSession(session.id)).toMatchObject({ messages: 20, migrated: true });
    expect(store.listMessages(session.id)).toHaveLength(20);
    expect(await migrateJsonlSession(session.id)).toMatchObject({ migrated: false });
  }, 60000);

  it('preserves existing v3 checkpoint IDs and exact decision state while adding missing boundaries', async () => {
    const { db, session, store, repo } = await setup();
    db.prepare('DELETE FROM session_history_storage WHERE session_id=?').run(session.id);
    store.appendMessage(message(session.id, 'early'));
    const exact = repo.capture(session.id, 'reply', 'early', null, 0);
    repo.session(session.id, { id: session.id, prompt: 'later decision', contextSnapshotId: null, resultSummary: null, sessionMetadata: {} });
    store.appendMessage(message(session.id, 'late'));
    const { migrateJsonlSession } = await import('../checkpoints/version-runtime/jsonl-migration.js');
    await migrateJsonlSession(session.id);
    expect(repo.checkpoint(session.id, exact.id).payload.versionId).toBe(exact.payload.versionId);
    expect(repo.checkpointForMessage(session.id, 'reply', 'late')?.payload.transcriptOnly).toBe(true);
    const { applyHistory } = await import('../checkpoints/operations.js');
    await applyHistory(session.id, { action: 'rollback', checkpointId: exact.id, revision: repo.head(session.id).revision, requestId: 'exact', includeFiles: false });
    expect(store.listMessages(session.id).map(m => m.id)).toEqual(['early']);
    expect(store.getSession(session.id).prompt).toBe(session.prompt);
  }, 60000);

  it('migrates legacy SQLite messages and keeps an existing legacy reply checkpoint addressable', async () => {
    const { db, session, store, repo } = await setup(); makeLegacy(db, session.id);
    const { transcriptRepository } = await import('../transcript-repository.js');
    for (const [n, id] of ['legacy-a','legacy-b'].entries()) transcriptRepository.insertLegacyRow({ id, session_id: session.id, role: 'assistant', content: id, metadata_json: '{}', created_at: session.createdAt, sequence: n + 1, project_id: session.projectId });
    db.prepare('INSERT INTO conversation_checkpoints(id,session_id,ordinal,kind,message_id,mutation_cursor,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('legacy-cp', session.id, 1, 'reply', 'legacy-a', 0, JSON.stringify({ version: 2, boundary: { legacy: true, cursor: 0, sessionIds: [session.id], messageCount: 1, messageSequence: 1 } }), session.createdAt);
    const { migrateJsonlSession } = await import('../checkpoints/version-runtime/jsonl-migration.js');
    await migrateJsonlSession(session.id);
    expect(repo.checkpoint(session.id, 'legacy-cp').messageId).toBe('legacy-a');
    expect(store.listMessages(session.id).map(m => m.content)).toEqual(['legacy-a','legacy-b']);
    expect((db.prepare('SELECT count(*) AS n FROM agent_runtime_messages WHERE session_id=?').get(session.id) as { n: number }).n).toBe(2);
  }, 60000);
  it('migrates append-only forks without violating their immutable rollback policy', async () => {
    const { db, session, store, repo } = await setup();
    db.prepare('DELETE FROM session_history_storage WHERE session_id=?').run(session.id);
    db.prepare('UPDATE conversation_v3_heads SET rollback_enabled=0 WHERE session_id=?').run(session.id);
    store.appendMessage(message(session.id, 'fork-message'));
    const { migrateJsonlSession } = await import('../checkpoints/version-runtime/jsonl-migration.js');
    expect(await migrateJsonlSession(session.id)).toMatchObject({ messages: 1, checkpoints: 0, migrated: true });
    expect(store.listMessages(session.id).map(m=>m.id)).toEqual(['fork-message']);
    expect(() => repo.capture(session.id,'reply','fork-message',null,0)).toThrow(/Forked/);
  });

  it('stores new child sessions in JSONL without enabling child rollback', async () => {
    const { session, repo, store } = await setup();
    const { agentSessionRuntime } = await import('../session-runtime.js');
    const { plannerSessionInput } = await import('./agent-runtime-fixtures.js');
    const child = agentSessionRuntime.create({ ...plannerSessionInput, profileId: "explorer", parentSessionId: session.id, workDir: root });
    store.appendMessage(message(child.id,'child-reply'));
    expect(store.listMessages(child.id).map(m=>m.id)).toEqual(['child-reply']);
    expect(() => repo.capture(child.id,'reply','child-reply',null,0)).toThrow(/Forked/);
  });

  it('preserves legacy before-images and historical decision state at an existing checkpoint', async () => {
    const { db, session, store, repo } = await setup(); makeLegacy(db, session.id);
    const { transcriptRepository } = await import('../transcript-repository.js');
    transcriptRepository.insertLegacyRow({ id:'old-answer',session_id:session.id,role:'assistant',content:'original answer',metadata_json:'{}',created_at:session.createdAt,sequence:1,project_id:session.projectId });
    const { captureCheckpoint } = await import('../checkpoints/store.js');
    const old = (await captureCheckpoint(session.id,'reply','old-answer'))!;
    db.prepare('UPDATE agent_runtime_messages SET content=? WHERE id=?').run('later edited answer','old-answer');
    db.prepare('UPDATE agent_runtime_sessions SET prompt=? WHERE id=?').run('later prompt',session.id);
    const { migrateJsonlSession } = await import('../checkpoints/version-runtime/jsonl-migration.js');
    await migrateJsonlSession(session.id);
    expect(store.listMessages(session.id)[0].content).toBe('later edited answer');
    const cp=repo.checkpoint(session.id,old.id);
    expect(cp.payload.transcriptOnly).toBe(false);
    const { applyHistory } = await import('../checkpoints/operations.js');
    await applyHistory(session.id,{action:'rollback',checkpointId:old.id,revision:repo.head(session.id).revision,requestId:'old-state',includeFiles:false});
    expect(store.listMessages(session.id)[0].content).toBe('original answer');
    expect(store.getSession(session.id).prompt).toBe(session.prompt);
  });

});
