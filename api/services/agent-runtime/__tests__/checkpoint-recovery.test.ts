import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { captureCheckpoint } from '../checkpoints/store.js';
import { withCheckpointMutation } from '../checkpoints/mutations.js';
import { checkpointFiles, diffManifests } from '../checkpoints/files.js';
import { applyHistory, previewHistory, recoverHistoryOperation } from '../checkpoints/operations.js';
import { forkCheckpoint } from '../checkpoints/fork.js';
import { historyRevision, assertHistoryUnlocked } from '../checkpoints/guards.js';
import { getRawSqlite } from '../../../db/index.js';
let root: string, id: string;
const create = (workDir: string) => { const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir }); store.updateSession(session.id,{status:'completed'}); return session.id; };
beforeEach(async () => { resetAgentRuntimeFixtures(); root = await fs.mkdtemp(path.join(os.tmpdir(),'synax-recovery-')); id = create(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root,{recursive:true,force:true}); });
async function checkpoint() {
  store.appendMessage({id:'reply',sessionId:id,role:'assistant',content:'done',runId:null,stepId:null,metadata:{},createdAt:new Date().toISOString()});
  return (await captureCheckpoint(id,'reply','reply'))!;
}
describe('history recovery safety', () => {
  it('compensates applied files when a later file write fails without truncating history', async () => {
    await fs.writeFile(path.join(root,'a'),'before-a'); await fs.writeFile(path.join(root,'b'),'before-b'); const cp = await checkpoint();
    await withCheckpointMutation(id,async()=> { await fs.writeFile(path.join(root,'a'),'after-a'); await fs.writeFile(path.join(root,'b'),'after-b'); });
    const realWrite = checkpointFiles.write.bind(checkpointFiles); let calls=0;
    vi.spyOn(checkpointFiles,'write').mockImplementation(async (...args) => { if (++calls===2) throw new Error('disk full'); await realWrite(...args); });
    await expect(applyHistory(id,{action:'rollback',checkpointId:cp.id,revision:0,requestId:'disk'})).rejects.toThrow('disk full');
    expect(await fs.readFile(path.join(root,'a'),'utf8')).toBe('after-a'); expect(await fs.readFile(path.join(root,'b'),'utf8')).toBe('after-b');
    expect(historyRevision(id)).toBe(0); expect(store.listMessages(id)).toHaveLength(1); expect(()=>assertHistoryUnlocked(id)).not.toThrow();
  });
  it('recovers a journal left between a filesystem write and DB commit', async () => {
    const canonical = await fs.realpath(root); await fs.writeFile(path.join(root,'a'),'old'); const before = await checkpointFiles.capture(root);
    await fs.writeFile(path.join(root,'a'),'new'); const after = await checkpointFiles.capture(root), changes = diffManifests([before],[after]);
    const db=getRawSqlite();
    db.prepare("INSERT INTO conversation_workspace_locks(root,operation_id) VALUES (?,'crashed')").run(canonical);
    db.prepare("INSERT INTO conversation_history_operations(id,session_id,request_hash,state,payload_json,created_at) VALUES ('crashed',?,'hash','applying',?,?)").run(id,JSON.stringify({ownerPid:process.pid,changes,applied:0,request:{}}),new Date().toISOString());
    await checkpointFiles.write(canonical,'a',changes[0].before);
    expect(()=>assertHistoryUnlocked(id)).toThrow();
    await recoverHistoryOperation(id);
    expect(await fs.readFile(path.join(root,'a'),'utf8')).toBe('new'); expect(()=>assertHistoryUnlocked(id)).not.toThrow();
  });
  it('marks overlapping writers uncertain rather than attributing their files by guesswork', async () => {
    const cp = await checkpoint(); let release!:()=>void; const gate = new Promise<void>(r=>release=r);
    let entered!:()=>void; const started = new Promise<void>(r=>entered=r);
    const first = withCheckpointMutation(id,async()=> { entered(); await gate; await fs.writeFile(path.join(root,'a'),'one'); });
    await started;
    const second = withCheckpointMutation(id,async()=> { await fs.writeFile(path.join(root,'b'),'two'); });
    await second; release(); await first;
    expect((await previewHistory(id,cp.id)).canApply).toBe(false);
  });
  it('does not undo a different session or manual editor, even if the resulting bytes match', async () => {
    await fs.writeFile(path.join(root,'file'),'before'); const cp=await checkpoint();
    await withCheckpointMutation(id,()=>fs.writeFile(path.join(root,'file'),'agent'));
    const other = create(root);
    await withCheckpointMutation(other,()=>fs.writeFile(path.join(root,'file'),'agent'));
    expect((await previewHistory(id,cp.id)).conflicts.some(c=>c.reason.includes('Another session'))).toBe(true);
  });
  it('keeps published checkpoints immutable after later writes', async () => {
    await fs.writeFile(path.join(root,'file'),'first'); const cp=await checkpoint();
    await withCheckpointMutation(id,()=>fs.writeFile(path.join(root,'file'),'later'));
    const repeated=await captureCheckpoint(id,'reply','reply'); expect(repeated).toEqual(cp);
    await applyHistory(id,{action:'rollback',checkpointId:cp.id,revision:0,requestId:'immutable'});
    expect(await fs.readFile(path.join(root,'file'),'utf8')).toBe('first');
  });
  it('forks dirty Git files without changing source HEAD, index or working files', async () => {
    const git = (...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    git('init','-b','main'); await fs.writeFile(path.join(root,'tracked'),'committed'); git('add','tracked'); git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base');
    await fs.writeFile(path.join(root,'tracked'),'historical dirty'); await fs.writeFile(path.join(root,'new'),'historical new'); const cp=await checkpoint();
    await fs.writeFile(path.join(root,'tracked'),'present'); git('add','tracked'); const sourceHead=git('rev-parse','HEAD'), index=git('write-tree');
    const result=await forkCheckpoint(id,cp.id,0,'git-fork'); const fork=store.getSession(result.sessionId), directory=(fork.sessionMetadata?.backend as {workDir:string}).workDir;
    try {
      expect(await fs.readFile(path.join(directory,'tracked'),'utf8')).toBe('historical dirty'); expect(await fs.readFile(path.join(directory,'new'),'utf8')).toBe('historical new');
      expect(git('rev-parse','HEAD')).toBe(sourceHead); expect(git('write-tree')).toBe(index); expect(await fs.readFile(path.join(root,'tracked'),'utf8')).toBe('present');
      expect(execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:directory,encoding:'utf8'}).trim()).toBe('HEAD');
    } finally { git('worktree','remove','--force',directory); }
  });
});
