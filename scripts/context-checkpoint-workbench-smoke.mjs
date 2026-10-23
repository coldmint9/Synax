/** Real workbench smoke: production client, HTTP host, Rust, worker and local
 * provider. Run after npm run client:build and cargo build --manifest-path
 * runtime-sidecar/Cargo.toml. Uses installed Chrome on macOS; elsewhere set
 * SYNAX_BROWSER_EXECUTABLE or use an existing Playwright browser installation.
 * Only disposable DATA_ROOT and test-owned processes are changed.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright-core";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output=path.join(repo,".tmp/checkpoint-workbench",String(Date.now()));
await fs.mkdir(output,{recursive:true});
console.log("ARTIFACTS",output);
const root=await fs.mkdtemp(path.join(os.tmpdir(),"synax-checkpoint-real-"));
const workspace=path.join(root,"workspace");await fs.mkdir(workspace);
execFileSync("git",["init","-b","main",workspace],{stdio:"ignore"});
await fs.writeFile(path.join(root,"projects.json"),JSON.stringify({items:[{id:"checkpoint-e2e",name:"Checkpoint acceptance",source:{kind:"localPath",localPath:workspace}}]}));
let calls=0,summaries=0,apiBase="",token="",hostLog="";
const probe=http.createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const webPort=probe.address().port;await new Promise(r=>probe.close(r));
const provider=http.createServer(async(req,res)=>{
 let raw="";for await(const part of req)raw+=part;
 const body=JSON.parse(raw);calls++;
 const compact=raw.includes("Maintain a structured conversation checkpoint");
 if(compact){summaries++;await new Promise(r=>setTimeout(r,1800));}
 const text=compact?JSON.stringify({summary:{goal:["Verify context compression"],constraints:["Keep original evidence readable"],decisions:[],completedWork:["Inspected historical evidence"],evidence:[],failures:[],openQuestions:[],nextActions:["Continue"]},sourceRefs:[]}):summaries===0?"ORIGINAL_EVIDENCE "+"Historical evidence remains recoverable. ".repeat(1800):"NEW_REPLY_AFTER_CHECKPOINT";
 const base={id:"fixture",model:"fixture",object:"chat.completion.chunk",created:0};
 res.writeHead(200,{"content-type":"text/event-stream"});
 res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{content:text},finish_reason:null}]})}\n\n`);
 res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}})}\n\n`);
 res.end("data: [DONE]\n\n");
});provider.listen(0,"127.0.0.1");await once(provider,"listening");
const env={...process.env,DATA_ROOT:root,PORT:"0",WEB_PORT:String(webPort),SYNAX_DESKTOP_SIDECAR:"1",SYNAX_AGENT_SESSION_IN_PROCESS:"0",NODE_ENV:"test",LOG_LEVEL:"warn",SYNAX_RUNTIME_SIDECAR_BIN:repo+"/runtime-sidecar/target/debug/synax-runtime-sidecar"};
for(const key of ["SYNAX_RUNTIME_SIDECAR_SOCKET","SYNAX_RUNTIME_SIDECAR_TOKEN","SYNAX_RUNTIME_PROVIDER_PORT","SYNAX_RUNTIME_SIDECAR_PORT"])delete env[key];
const host=spawn(process.execPath,["--import","tsx/esm","services/local-node/entrypoints/http-server.ts"],{cwd:repo,env,stdio:["ignore","pipe","pipe","ipc"]});
host.stderr.on("data",d=>hostLog+=String(d));
const server=http.createServer(async(req,res)=>{
 if(req.url?.startsWith("/api")){
  const url=new URL(apiBase);const up=http.request({hostname:url.hostname,port:url.port,path:req.url,method:req.method,headers:{...req.headers,host:url.host,authorization:`Bearer ${token}`}},r=>{res.writeHead(r.statusCode??502,r.headers);if(req.url?.includes("/stream"))r.on("data",b=>{const t=String(b);if(t.includes("context_compaction"))hostLog+="\nCOMPACTION_SSE "+t.slice(0,3000)});r.pipe(res)});
  up.on("error",()=>{res.writeHead(502);res.end()});req.pipe(up);return;
 }
 const dist=path.join(repo,"client/dist");let file=path.resolve(dist,"."+new URL(req.url??"/","http://local").pathname);
 if(!file.startsWith(dist+path.sep))file=path.join(dist,"index.html");
 let bytes;try{bytes=await fs.readFile(file)}catch{file=path.join(dist,"index.html");bytes=await fs.readFile(file)}
 res.setHeader("content-type",({".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".woff2":"font/woff2"})[path.extname(file)]??"text/html");res.end(bytes);
});
server.on("upgrade",(req,socket,head)=>{
 hostLog+="\nWS_PROXY "+req.url;
 const target=new URL(apiBase);const upstream=net.connect(Number(target.port),target.hostname,()=>{
  const headers=Object.entries(req.headers).filter(([key])=>!["host","authorization"].includes(key.toLowerCase())).map(([key,value])=>`${key}: ${value}`).join("\r\n");
  upstream.write(`${req.method} ${req.url} HTTP/1.1\r\nhost: ${target.host}\r\nauthorization: Bearer ${token}\r\n${headers}\r\n\r\n`);
  if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
 });upstream.on("error",()=>socket.destroy());socket.on("error",()=>upstream.destroy());
});
let browser,page,currentSession;const errors=[];let success=false;
async function api(route,body,method=body===undefined?"GET":"POST"){
 const r=await fetch(apiBase+route,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
 const value=await r.json();assert(r.ok,`${route} ${r.status} ${JSON.stringify(value)}`);return value;
}
async function until(read,done,label){const end=Date.now()+45000;for(;;){const v=await read();if(done(v))return v;if(Date.now()>end)throw new Error(`Timed out ${label}: ${JSON.stringify(v).slice(0,1000)}`);await new Promise(r=>setTimeout(r,100));}}
try{
 await new Promise((resolve,reject)=>{let out="";const timeout=setTimeout(()=>reject(new Error("host startup timeout")),45000);host.once("exit",c=>reject(new Error(`host exited ${c}`)));host.stdout.on("data",d=>{hostLog+=String(d);out+=String(d);const p=/SYNAX_DESKTOP_READY:(\d+)/.exec(out)?.[1];if(p){apiBase=`http://127.0.0.1:${p}`;clearTimeout(timeout);resolve(null)}})});
 token=(await fs.readFile(path.join(root,"runtime-access-token"),"utf8")).trim();
 await api("/api/config/global",{defaultApiProviderId:"openai",providerConnections:{openai:{providerId:"openai",apiKey:"fixture",baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,extra:{kind:"api",apiFormat:"openai",model:"fixture"}}}},"PUT");
 const created=await api("/api/agent-runtime/sessions",{projectId:"checkpoint-e2e",profileId:"synax",sessionMetadata:{mode:"chat",source:"session-page"},prompt:"Keep original evidence readable",workDir:workspace});
 const id=created.session.id;currentSession=id;
 const run=await api(`/api/agent-runtime/sessions/${id}/runs`,{requestId:"first",message:"Inspect original evidence",mode:"turn"});
 const finished=await until(()=>api(`/api/agent-runtime/sessions/${id}/runs/${run.run.id}`),r=>["completed","failed","interrupted"].includes(r.status),"first run");assert.equal(finished.status,"completed",finished.stopReason);
 server.listen(webPort,"127.0.0.1");await once(server,"listening");const web=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.SYNAX_BROWSER_EXECUTABLE ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),headless:true});
 page=await browser.newPage({viewport:{width:1280,height:900}});page.on("pageerror",e=>errors.push(e.message));
 page.on("console",m=>{if(m.type()==="error")hostLog+="\nCONSOLE "+m.text().slice(0,500)});
 page.on("websocket",ws=>{hostLog+="\nWS "+new URL(ws.url()).pathname;ws.on("socketerror",e=>hostLog+="\nWS_ERROR "+String(e));ws.on("framereceived",f=>{const t=String(f.payload);if(t.includes("compaction")||t.includes('"type":"error"'))hostLog+="\nWS_FRAME "+t.slice(0,3500)});});page.on("response",r=>{if(r.url().endsWith("/context/compact"))void r.text().then(body=>fs.writeFile(output+"/compact-response.json",JSON.stringify({status:r.status(),body})));if(r.status()>=400)hostLog+=`\nHTTP ${r.status()} ${r.url()}`});
 await page.goto(`${web}/projects/checkpoint-e2e/sessions?session=${id}`);
 await page.getByText("Inspect original evidence",{exact:true}).first().waitFor({timeout:45000});
 await page.screenshot({path:output+"/before.png"});
 const add=page.getByRole("button",{name:/添加附件、上下文或切换模式|Add attachments, context or change mode|添加上下文|Add context/});
 await add.last().click();await page.getByRole("button",{name:/强制压缩上下文|Force compact context/}).click();
 await page.getByText(/正在压缩上下文|Compacting context/).first().waitFor({timeout:15000});await page.screenshot({path:output+"/running.png"});
 await page.getByText(/此前上下文已压缩|Earlier context compacted/).first().waitFor({timeout:45000});await page.screenshot({path:output+"/completed.png"});
 assert(summaries>0);await page.reload();await page.getByText(/此前上下文已压缩|Earlier context compacted/).first().waitFor({timeout:45000});
 await page.getByText("Inspect original evidence",{exact:true}).first().waitFor();
 const messageId=finished.triggerMessageId;assert(messageId);
 const sealed=await api(`/api/agent-runtime/sessions/${id}/checkpoints`,{messageIds:[messageId]});assert(sealed.readOnlyMessageIds.includes(messageId));
 const edit=await fetch(`${apiBase}/api/agent-runtime/sessions/${id}/history/edit`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({messageId,message:"changed",requestId:"sealed-edit",includeFiles:false})});assert.equal(edit.status,409);
 await page.setViewportSize({width:420,height:900});await page.screenshot({path:output+"/narrow.png"});
 assert.deepEqual(errors,[]);success=true;
 await fs.writeFile(output+"/result.json",JSON.stringify({success,sessionId:id,calls,summaries,errors,checks:["real production frontend","real HTTP/Rust/worker/provider","UI compact click","live progress","durable completed marker","reload preserves history","sealed message classified and edit rejected"],artifacts:output},null,2));
 console.log("WORKBENCH_CHECKPOINT_PASS",JSON.stringify({calls,summaries,errors}));
}catch(e){console.error(String(e.stack??e));await fs.writeFile(output+"/host.log",hostLog);if(currentSession){try{await fs.writeFile(output+"/backend-state.json",JSON.stringify({summary:await api(`/api/agent-runtime/sessions/${currentSession}/summary`),checkpoints:await api(`/api/agent-runtime/sessions/${currentSession}/checkpoints`)},null,2))}catch{}}if(page)await fs.writeFile(output+"/body.txt",await page.locator("body").innerText());await fs.writeFile(output+"/failure.txt",String(e.stack??e));if(page)await page.screenshot({path:output+"/failure.png"});await fs.writeFile(output+"/diagnostic.json",JSON.stringify({calls,summaries,errors},null,2));throw e}
finally{await browser?.close();server.closeAllConnections();server.close();provider.closeAllConnections();provider.close();const exited=host.exitCode!==null||host.signalCode!==null?Promise.resolve():once(host,"exit").catch(()=>{});host.kill("SIGTERM");const timer=setTimeout(()=>host.kill("SIGKILL"),10000);await exited;clearTimeout(timer);await fs.writeFile(output+"/host.log",hostLog);if(success)await fs.rm(root,{recursive:true,force:true});else console.log("DATA_ROOT",root)}
