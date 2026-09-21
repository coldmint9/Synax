import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildWorkerSource } from '../build-worker.js';
const hostRequire=createRequire(import.meta.url);
let root:string, modulesRoot:string, approved:string;
beforeEach(()=>{
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'artifact-worker-deps-')));
  modulesRoot=path.join(root,'node_modules'); approved=path.join(modulesRoot,'approved'); fs.mkdirSync(approved,{recursive:true});
  fs.writeFileSync(path.join(approved,'package.json'),'{"name":"approved","main":"index.js"}');
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
async function attempt() {
  const worker=new Worker(buildWorkerSource,{eval:true,execArgv:[],workerData:{esbuildPath:hostRequire.resolve('esbuild'),parse5Path:hostRequire.resolve('parse5'),workingDirectory:root,modulesRoot,packageRoots:[approved],dependencies:{approved:path.join(approved,'index.js')}}});
  try {
    return await new Promise<{type:string;code?:string;message?:string;js?:string}>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Worker test timed out')),5000);
      worker.once('error',error=>{clearTimeout(timer);reject(error);});
      worker.on('message',message=>{clearTimeout(timer);resolve(message);});
      worker.postMessage({type:'build',id:1,entry:{path:'entry.js',content:'import {value} from "approved"; window.value=value;',mediaType:'text/javascript',encoding:'utf8'}});
    });
  } finally { await worker.terminate(); }
}
it('allows fixed package code but rejects imports into unrelated installed packages',async()=>{
  fs.writeFileSync(path.join(approved,'index.js'),'export const value=42;');
  expect(await attempt()).toMatchObject({type:'built'});
  const sibling=path.join(modulesRoot,'unapproved');fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling,'package.json'),'{"name":"unapproved","main":"index.js"}');
  fs.writeFileSync(path.join(sibling,'index.js'),'export const value="NOT_ALLOWED";');
  fs.writeFileSync(path.join(approved,'index.js'),'export {value} from "unapproved";');
  expect(await attempt()).toMatchObject({type:'error',code:'UNSUPPORTED_IMPORT'});
});
it('rejects symlink and relative escapes outside the package tree before loading code',async()=>{
  fs.writeFileSync(path.join(root,'outside.js'),'export const value="OUTSIDE_SECRET";');
  fs.symlinkSync(path.join(root,'outside.js'),path.join(approved,'link.js'));
  fs.writeFileSync(path.join(approved,'index.js'),'export {value} from "./link.js";');
  const linked=await attempt();expect(linked).toMatchObject({type:'error',code:'UNSUPPORTED_IMPORT'});expect(linked.js).toBeUndefined();
  fs.writeFileSync(path.join(approved,'index.js'),'export {value} from "../../outside.js";');
  expect(await attempt()).toMatchObject({type:'error',code:'UNSUPPORTED_IMPORT'});
});
it('does not allow undeclared nested node_modules merely because their parent is trusted',async()=>{
  const nested=path.join(approved,'node_modules','hidden');fs.mkdirSync(nested,{recursive:true});
  fs.writeFileSync(path.join(nested,'package.json'),'{"name":"hidden","main":"index.js"}');
  fs.writeFileSync(path.join(nested,'index.js'),'export const value="NESTED_SECRET";');
  fs.writeFileSync(path.join(approved,'index.js'),'export {value} from "hidden";');
  expect(await attempt()).toMatchObject({type:'error',code:'UNSUPPORTED_IMPORT'});
});
it('emits identical virtual CommonJS identities after moving the installed package tree',async()=>{
  fs.writeFileSync(path.join(approved,'index.js'),'module.exports.value=42;');
  const first=await attempt(); expect(first.type).toBe('built');
  const relocated=path.join(root,'different-deployment','node_modules'); fs.cpSync(modulesRoot,relocated,{recursive:true});
  modulesRoot=relocated; approved=path.join(modulesRoot,'approved');
  const second=await attempt(); expect(second.type).toBe('built');
  expect(second.js).toBe(first.js);
  expect(first.js).toContain('dependency:package-0/index.js');
  expect(first.js).not.toContain(root); expect(second.js).not.toContain(relocated);
});
