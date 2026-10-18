import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentSession } from './contracts.js';
import { agentRuntimeStore } from './session-store.js';
import { runtimeClient, decode } from './sidecar/runtime-repository.js';
import { RuntimeSidecarError } from './sidecar/sidecar-client.js';
import { resolveSessionWorkspaceRoots } from './tools/workspace.js';
import { workspaceLocationHostPath } from '../workspace-location.js';
import { recordGitBoundary, fileGitPreservation } from './runtime-files-git.js';

export interface RuntimeFileVersion { kind: 'file' | 'symlink'; hash: string; mode: number; size: number; blobId: string }
export interface RuntimeGitBoundary { root: string; path: string; head: string | null; unverified?: boolean }
export interface RuntimeFileChange { root: string; path: string; before: RuntimeFileVersion | null; after: RuntimeFileVersion | null; git?: RuntimeGitBoundary }
export interface RuntimeFileConflict { root: string; path: string; reason: string }
export interface RuntimeFilePreview { files: RuntimeFileChange[]; conflicts: RuntimeFileConflict[]; preservedFiles: RuntimeFileConflict[]; warnings: string[] }
const active = new Set<string>();
export const FILE_EXCLUSIONS = 'Only recorded agent writes are restored. Manual changes, committed files and untracked command effects are preserved.';

function excluded(relative: string): boolean {
  const parts=relative.split('/'), name=parts.at(-1)!;
  return parts.some(p=>['.git','node_modules','.pnpm-store','.yarn','.cache','.tmp','.next','.nuxt','__pycache__','.venv','venv','.pytest_cache','.turbo','.gradle','.idea','.synax-forks'].includes(p))
    || name==='.DS_Store' || name.startsWith('.synax-restore-')
    || (/^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name))
    || /^(id_(rsa|ed25519|ecdsa)|credentials(?:\.json)?|\.npmrc|\.netrc)$/.test(name) || /\.(pem|key|p12|pfx)$/.test(name);
}
function canonicalTarget(file: string): string {
  let parent=path.dirname(path.resolve(file));const suffix=[path.basename(file)];
  for (;;) {
    try {return path.join(fs.realpathSync(parent),...suffix);}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const next=path.dirname(parent);if(next===parent)throw error;suffix.unshift(path.basename(parent));parent=next;}
  }
}
export async function fileOwner(sessionId: string): Promise<string> {
  let current=agentRuntimeStore.getSession(sessionId);
  while(current.parentSessionId) current=agentRuntimeStore.tryGetSession(current.parentSessionId)
    ?? decode<{session:AgentSession}>(await runtimeClient().uiSnapshot(current.parentSessionId)).session;
  return current.id;
}
export async function fileCommand<T>(sessionId: string, operation: string, payload: unknown, requestId=randomUUID() as string): Promise<T> {
  return decode<T>(await runtimeClient().historyCommand({sessionId,requestId,operation,payload}));
}

/** Native operations run only after Rust has committed their before-images. */
export async function withRuntimeFileMutation<T>(sessionId: string, action:()=>T|Promise<T>, external=false, paths?: string[], signal?:AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const session=agentRuntimeStore.getSession(sessionId), owner=await fileOwner(sessionId);
  const roots=resolveSessionWorkspaceRoots(sessionId,session.projectId).filter(root=>root.status==='available')
    .map(root=>fs.realpathSync(root.location?workspaceLocationHostPath(root.location):root.path));
  const targets: Array<{root:string;path:string;git?:RuntimeGitBoundary}>=[];
  const gitRoots=new Map<string,RuntimeGitBoundary|undefined>();
  for(const file of new Set(paths??[])) {
    const absolute=canonicalTarget(file), root=roots.find(root=>absolute.startsWith(root+path.sep));
    if(!root)continue;
    const relative=path.relative(root,absolute).split(path.sep).join('/');if(excluded(relative))continue;
    let git:RuntimeGitBoundary|undefined;
    if(!external) {
      if(!gitRoots.has(root)) {const boundary=await recordGitBoundary(root,relative);gitRoots.set(root,boundary?{...boundary,path:boundary.path.slice(0,-relative.length)}:undefined);}
      const base=gitRoots.get(root);git=base?{...base,path:base.path+relative}:undefined;
    }
    targets.push({root,path:relative,...(git?{git}:{})});
  }
  const deadline=Date.now()+15_000;
  let mutation:{id:string};
  let recovered=false;
  for(;;) {
    signal?.throwIfAborted();
    try {mutation=await fileCommand(owner,'file_begin',{sourceSessionId:sessionId,ownerPid:process.pid,roots,targets,external});break;}
    catch(error) {
      if(!(error instanceof RuntimeSidecarError)||error.code!=='FILE_WRITE_BUSY'||Date.now()>=deadline)throw error;
      if(!recovered){await recoverAbandonedFileWriters();recovered=true;}
      await delay(50,undefined,{signal});
    }
  }
  active.add(mutation.id);
  let result:T|undefined, failure:unknown, failed=false;
  try {signal?.throwIfAborted();result=await action();} catch(error) {failure=error;failed=true;}
  try {await fileCommand(owner,'file_finish',{id:mutation.id});}
  catch(error) {
    try{await fileCommand(owner,'file_abandon',{id:mutation.id});}
    catch(cleanup){throw new AggregateError([error,cleanup],'File history requires recovery');}
    if(failed)throw new AggregateError([failure,error],'File operation and history commit failed');throw error;
  }
  finally {active.delete(mutation.id);}
  if(failed)throw failure;
  return result as T;
}

export async function previewRuntimeFiles(sessionId: string, checkpointId: string): Promise<RuntimeFilePreview> {
  const result=await fileCommand<RuntimeFilePreview>(sessionId,'file_preview',{checkpointId});
  const files:RuntimeFileChange[]=[];
  for(const change of result.files) {
    const preservation=await fileGitPreservation(change);
    if(preservation) result.preservedFiles.push({root:change.root,path:change.path,reason:preservation.reason});
    else files.push(change);
  }
  const preserved=new Set(result.preservedFiles.map(c=>JSON.stringify([c.root,c.path])));
  return {...result,files,conflicts:result.conflicts.filter(c=>!preserved.has(JSON.stringify([c.root,c.path])))};
}
export async function pendingRuntimeFiles(): Promise<{items:Array<{id:string;sessionId:string;ownerPid:number}>;restores:Array<{sessionId:string;requestId:string;state:string}>}> {
  return decode(await runtimeClient().historyCommandGlobal({sessionId:'__files__',requestId:randomUUID(),operation:'file_pending',payload:{}}));
}
export async function recoverAbandonedFileWriters(): Promise<string[]> {
  const pending=await pendingRuntimeFiles();
  for(const item of pending.items) {
    let live=item.ownerPid===process.pid?active.has(item.id):true;
    if(item.ownerPid!==process.pid)try {process.kill(item.ownerPid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')live=false;else throw error;}
    if(!live)await fileCommand(item.sessionId,'file_abandon',{id:item.id});
  }
  return pending.restores.map(item=>item.sessionId);
}
