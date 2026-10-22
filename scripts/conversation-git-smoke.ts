/** Real Git + Rust persistence + production service acceptance. No model/provider calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';

const keep = process.argv.includes('--serve');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'synax-conversation-integration-'));
const repo = path.join(fixture, 'repo');
const dataRoot = path.join(fixture, 'data');
await fs.mkdir(repo); await fs.mkdir(dataRoot);
process.env.DATA_ROOT=dataRoot;process.env.LOG_LEVEL='error';process.env.NODE_ENV='test';
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const commit=async(text:string,label:string)=>{await fs.writeFile(path.join(repo,'auth.ts'),text);git('add','auth.ts');git('commit','-m',label);};
git('init','-b','main');git('config','user.name','Synax Acceptance');git('config','user.email','acceptance@example.test');
await commit('export const behavior = "base";\n','Initialize session middleware');
git('checkout','-b','feature/session-refresh');
await commit('export const behavior = "refresh";\n','Refresh expiring sessions');
git('checkout','main');
await commit('export const behavior = "rotate";\n','Rotate signing keys');
git('checkout','-b','review');
const targetBefore=git('rev-parse','main');
await fs.writeFile(path.join(dataRoot,'projects.json'),JSON.stringify({items:[{id:'conversation-git-acceptance',name:'Synax 合并交互验收',status:'healthy',environment:'development',healthScore:100,activeAgents:0,activeHumans:1,openRisks:0,updatedAt:new Date().toISOString(),source:{kind:'localPath',localPath:repo}}]}));
const {RustRuntimeSupervisor}=await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const {agentRuntimeStore}=await import('../services/local-node/modules/agent-runtime/session-store.js');
const {agentSessionRuntime}=await import('../services/local-node/modules/agent-runtime/session-runtime.js');
const {conversationGitService}=await import('../services/local-node/modules/agent-runtime/conversation-git/service.js');
const {runtimeFacade}=await import('../services/local-node/modules/agent-runtime/sidecar/runtime-facade.js');
const {ensureSynaxAgentRegistered}=await import('../services/local-node/modules/agent-runtime/synax/index.js');
const {sessionLiveBus}=await import('../services/local-node/modules/agent-runtime/session-live-bus.js');
ensureSynaxAgentRegistered();
let supervisor=new RustRuntimeSupervisor({dataRoot});
const children:ChildProcess[]=[];
const report:Record<string,unknown>={fixture};
try{
 await supervisor.start();
 const session=agentSessionRuntime.create({projectId:'conversation-git-acceptance',profileId:'synax',prompt:'把会话刷新功能合并到 main。有冲突先让我看一下，检查通过后再确认合并。',workDir:repo,sessionMetadata:{source:'session-page',mode:'chat'}});
 agentRuntimeStore.updateSession(session.id,{title:'合并会话刷新功能',status:'completed'});
 agentRuntimeStore.appendMessage({id:randomUUID(),sessionId:session.id,runId:null,stepId:null,role:'user',content:session.prompt,metadata:{source:'turn_request'},createdAt:session.createdAt});
 await agentRuntimeStore.flushSession(session.id);
 let observed=0;const detach=sessionLiveBus.subscribe(session.id,event=>{if(event.type==='conversation_git_messages')observed++;});
 const check={id:'behavior',executable:process.execPath,args:['-e',`const fs=require('fs');const assert=require('assert');const code=fs.readFileSync('auth.ts','utf8');assert(code.includes('refresh')&&code.includes('rotate'),'Both refresh and key rotation must be retained');console.log('Session integration check passed')`],timeoutMs:10000};
 let snapshot=await conversationGitService.create(session.id,{requestId:randomUUID(),title:'会话刷新与认证优化',target:'main',sources:['feature/session-refresh'],strategy:'merge_commit',checks:[check]});
 const objectId=snapshot.task.id;
 const action=async(name:import('../services/local-node/modules/agent-runtime/conversation-git/contracts.js').ConversationGitActionName)=>{snapshot=await conversationGitService.action(session.id,objectId,{action:name,requestId:randomUUID(),expectedVersion:snapshot.mr.version,expectedTaskRevision:snapshot.task.revision});};
 assert.equal(snapshot.mr.status,'draft');await action('prepare');assert.equal(snapshot.mr.status,'conflicted');assert.equal(git('rev-parse','main'),targetBefore);
 const file=await conversationGitService.file(session.id,objectId,snapshot.files.find(f=>f.conflicted)!.id);
 const proposal=await conversationGitService.propose(session.id,objectId,{fileId:file.id,revision:file.revision,content:'export const behavior = "rotate + refresh";\n',rationale:'先保留 main 的密钥轮换，再保留 feature 的会话刷新。'});
 snapshot=await conversationGitService.get(session.id,objectId);
 snapshot=await conversationGitService.applyProposal(session.id,objectId,{proposalId:proposal.id,requestId:randomUUID(),expectedVersion:snapshot.mr.version,expectedTaskRevision:snapshot.task.revision});
 const proposed=await conversationGitService.file(session.id,objectId,file.id);
 snapshot=await conversationGitService.saveFile(session.id,objectId,file.id,{requestId:randomUUID(),expectedVersion:snapshot.mr.version,expectedTaskRevision:snapshot.task.revision,expectedRevision:proposed.revision,content:proposed.result,resolve:true});
 await action('continue');await action('checks');assert.equal(snapshot.mr.checkResults[0].status,'passed');await action('finalize');assert.equal(snapshot.mr.status,'merged');assert.equal(git('rev-parse','main'),snapshot.mr.candidateOid);
 const messages=agentRuntimeStore.listMessages(session.id);assert.equal(messages.filter(m=>m.metadata.source==='git_merge_task').length,1);assert(messages.some(m=>m.metadata.source==='git_merge_receipt'));assert(observed>0);detach();
 await agentRuntimeStore.flushSession(session.id);
 const history=await runtimeFacade.historyWindowAuthoritative(session.id);assert(history.messages.some(m=>(m.metadata.gitMergeTask as {objectId?:string})?.objectId===objectId));
 await supervisor.stop();supervisor=new RustRuntimeSupervisor({dataRoot});await supervisor.start();agentRuntimeStore.reset();await agentRuntimeStore.hydrateSession(session.id);
 const restored=await conversationGitService.get(session.id,objectId);assert.equal(restored.mr.status,'merged');assert.equal(restored.task.messageId,snapshot.task.messageId);assert.equal(agentRuntimeStore.listMessages(session.id).filter(m=>m.metadata.source==='git_merge_task').length,1);
 Object.assign(report,{passed:true,objectId,sessionId:session.id,candidateOid:snapshot.mr.candidateOid,liveEvents:observed,checks:'real Git conflicts, proposals, draft/apply, candidate verification, final ref update, Rust history and restart restoration'});
 if(keep){
  // A second source prepared from the current production baseline leaves a fresh task for browser QA.
  git('checkout','main');git('checkout','-b','feature/session-refresh-v2');await commit('export const behavior = "refresh-v2";\n','Refine session refresh');git('checkout','main');await commit('export const behavior = "rotate-v2";\n','Rotate session keys v2');git('checkout','review');
  const demo=agentSessionRuntime.create({projectId:'conversation-git-acceptance',profileId:'synax',prompt:'把会话刷新功能合并到 main。有冲突先让我看一下，检查通过后再确认合并。',workDir:repo,sessionMetadata:{source:'session-page',mode:'chat'}});agentRuntimeStore.updateSession(demo.id,{title:'合并会话刷新功能 · 真实数据',status:'completed'});agentRuntimeStore.appendMessage({id:randomUUID(),sessionId:demo.id,runId:null,stepId:null,role:'user',content:demo.prompt,metadata:{source:'turn_request'},createdAt:demo.createdAt});await agentRuntimeStore.flushSession(demo.id);
  let task=await conversationGitService.create(demo.id,{requestId:randomUUID(),title:'会话刷新与认证优化',target:'main',sources:['feature/session-refresh-v2'],strategy:'merge_commit',checks:[check]});task=await conversationGitService.action(demo.id,task.task.id,{action:'prepare',requestId:randomUUID(),expectedVersion:task.mr.version,expectedTaskRevision:task.task.revision});
  const preview=await conversationGitService.file(demo.id,task.task.id,task.files.find(f=>f.conflicted)!.id);await conversationGitService.propose(demo.id,task.task.id,{fileId:preview.id,revision:preview.revision,content:'export const behavior = "rotate-v2 + refresh-v2";\n',rationale:'同时保留密钥轮换和过期会话刷新，两种业务行为都进入最终结果。'});await agentRuntimeStore.flush();await supervisor.stop();
  const freePort=async()=>{const server=http.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;};
  const apiPort=await freePort(),webPort=await freePort();
  const env={...process.env,DATA_ROOT:dataRoot,PORT:String(apiPort),WEB_PORT:String(webPort),LOG_LEVEL:'error'};delete env.SYNAX_RUNTIME_SIDECAR_SOCKET;delete env.SYNAX_RUNTIME_SIDECAR_TOKEN;delete env.SYNAX_RUNTIME_SIDECAR_PORT;
  if(process.argv.includes('--remote-fixture')){
    const {installRemotePrFixture}=await import('./fixtures/install-remote-pr-fixture.js');
    const cliDir=await installRemotePrFixture(fixture,repo);env.PATH=cliDir+path.delimiter+env.PATH;
  }
  const logs=await fs.open(path.join(fixture,'api.log'),'a');
  const api=spawn(process.execPath,['--import','tsx','services/local-node/entrypoints/http-server.ts'],{cwd:process.cwd(),env,stdio:['ignore',logs.fd,logs.fd]});children.push(api);
  const web=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{cwd:path.resolve('client'),env,stdio:['ignore',logs.fd,logs.fd]});children.push(web);
  const url=`http://127.0.0.1:${webPort}/projects/conversation-git-acceptance/sessions?session=${encodeURIComponent(demo.id)}`;
  Object.assign(report,{url,apiPort,webPort,demoSessionId:demo.id,demoObjectId:task.task.id,dataRoot});await fs.writeFile(path.join(fixture,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
 }else console.log(JSON.stringify(report,null,2));
}finally{for(const child of children)child.kill('SIGTERM');await supervisor.stop();if(!keep)await fs.rm(fixture,{recursive:true,force:true});}
