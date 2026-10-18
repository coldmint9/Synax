import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentSession } from '../services/local-node/modules/agent-runtime/contracts.js';

const root=await mkdtemp(path.join(tmpdir(),'synax-v2-files-'));
await mkdir(path.join(root,'workspace'));
const workspace=await realpath(path.join(root,'workspace')), file=path.join(workspace,'tracked.txt');
process.env.DATA_ROOT=root;process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';
await writeFile(path.join(root,'projects.json'),JSON.stringify({items:[{id:'p',source:{localPath:workspace}}]}));
const {RustRuntimeSupervisor}=await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const {agentRuntimeStore:store}=await import('../services/local-node/modules/agent-runtime/session-store.js');
const {runtimeFacade}=await import('../services/local-node/modules/agent-runtime/sidecar/runtime-facade.js');
const {withRuntimeFileMutation,fileCommand,pendingRuntimeFiles}=await import('../services/local-node/modules/agent-runtime/runtime-files.js');
const {captureCheckpoint}=await import('../services/local-node/modules/agent-runtime/runtime-history.js');
const execute=promisify(execFile);
const git=(...args:string[])=>execute('git',['-c','user.name=Runtime Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:workspace});
let supervisor=new RustRuntimeSupervisor({dataRoot:root});
try {
  await git('init');await writeFile(file,'base\n');await git('add','tracked.txt');await git('commit','-m','base');
  await supervisor.start();
  const now=new Date().toISOString();
  const session:AgentSession={id:'s',projectId:'p',parentSessionId:null,childSessionIds:[],nodeId:null,profileId:'synax',status:'completed',title:'files',prompt:'restore files',contextSnapshotId:null,
    thinkingMode:'standard',reasoningEffort:null,permissionRules:[],skillIds:[],mcpServerIds:[],createdAt:now,updatedAt:now,completedAt:null,resultSummary:null,blockedReason:null,activeRunId:null,pendingResumeToken:null,sessionMetadata:{backend:{id:'native',workDir:workspace}}};
  store.createSession(session);
  store.appendMessage({id:'baseline',sessionId:'s',runId:null,stepId:null,role:'assistant',content:'baseline',metadata:{},createdAt:now});
  await captureCheckpoint('s','reply','baseline');
  const checkpointId='rust_checkpoint_reply_baseline';
  await withRuntimeFileMutation('s',()=>writeFile(file,'agent\n'),false,[file]);
  store.appendMessage({id:'later',sessionId:'s',runId:null,stepId:null,role:'assistant',content:'later',metadata:{},createdAt:now});await store.flush();
  const preview=await runtimeFacade.previewHistoryAuthoritative('s',checkpointId,true);
  assert.equal(preview.files.length,1);assert(preview.canApply);
  await runtimeFacade.controlCommand({sessionId:'s',requestId:'begin-recovery',operation:'history_begin',payload:{historyRequestId:'recover-this'}});
  await fileCommand('s','restore_checkpoint',{checkpointId,expectedRevision:preview.revision,includeFiles:true},'recover-this');
  // Crash boundary: the filesystem/head committed, but hot state is not reset yet.
  await supervisor.stop();supervisor=new RustRuntimeSupervisor({dataRoot:root});await supervisor.start();
  await runtimeFacade.recoverHistoryAuthoritative('s');
  assert.equal(await readFile(file,'utf8'),'base\n');
  assert.deepEqual(store.listMessages('s').map(message=>message.id),['baseline']);
  assert.equal(store.getSession('s').status,'completed');
  assert.equal((await pendingRuntimeFiles()).restores.length,0);

  await withRuntimeFileMutation('s',()=>writeFile(file,'committed\n'),false,[file]);
  await git('add','tracked.txt');await git('commit','-m','keep committed work');
  const committed=await runtimeFacade.previewHistoryAuthoritative('s',checkpointId,true);
  assert.equal(committed.files.length,0);assert.equal(committed.preservedFiles.length,1);
  await runtimeFacade.applyHistoryAuthoritative({sessionId:'s',checkpointId,revision:committed.revision,requestId:'keep-git',action:'rollback',includeFiles:true});
  assert.equal(await readFile(file,'utf8'),'committed\n');

  await withRuntimeFileMutation('s',()=>writeFile(file,'agent again\n'),false,[file]);
  await writeFile(file,'manual edit\n');
  const conflict=await runtimeFacade.previewHistoryAuthoritative('s',checkpointId,true);assert(!conflict.canApply);
  await assert.rejects(runtimeFacade.applyHistoryAuthoritative({sessionId:'s',checkpointId,revision:conflict.revision,requestId:'conflict',action:'rollback'}),/independent file changes/);
  assert.equal(await readFile(file,'utf8'),'manual edit\n');
  await withRuntimeFileMutation('s',()=>writeFile(file,'saved by user\n'),true,[file]);
  const manual=await runtimeFacade.previewHistoryAuthoritative('s',checkpointId,true);
  assert(manual.canApply);assert.equal(manual.files.length,0);assert.equal(manual.preservedFiles.length,1);
  await runtimeFacade.applyHistoryAuthoritative({sessionId:'s',checkpointId,revision:manual.revision,requestId:'keep-manual',action:'rollback'});
  assert.equal(await readFile(file,'utf8'),'saved by user\n');
  assert.equal(existsSync(path.join(root,'context.db')),false);
  console.log('Native file history smoke passed: before-images, exact head restore, restart between file/head and hot commit, Git preservation, manual-edit conflicts, editor changes; no SQLite.');
} finally {await supervisor.stop();await rm(root,{recursive:true,force:true});}
