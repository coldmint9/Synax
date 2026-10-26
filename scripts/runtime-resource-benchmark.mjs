/** Isolated source-level comparison; no production sessions, provider APIs, or credentials. */
import { mkdtemp, readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const output = path.resolve(process.env.SYNAX_RESOURCE_BENCH_OUTPUT ?? '.tmp/runtime-performance/resource-benchmark.json');
const deps = path.resolve('runtime-sidecar/target/release/deps');
const root = await mkdtemp(path.join(os.tmpdir(), 'synax-resource-bench-'));
const sourcePath = 'runtime-sidecar/src/runtime/resources.rs';
const baseline = execFileSync('git', ['show', `HEAD:${sourcePath}`], { encoding: 'utf8' });
const current = await readFile(sourcePath, 'utf8');
const externs = [];
for (const name of ['parking_lot', 'serde', 'serde_json', 'tracing', 'sha2', 'tokio']) {
  const files = await Promise.all((await readdir(deps)).filter(file => file.startsWith(`lib${name}-`) && file.endsWith('.rlib'))
    .map(async file => ({ path: path.join(deps, file), at: (await stat(path.join(deps, file))).mtimeMs })));
  files.sort((a, b) => b.at - a.at);
  if (!files.length) throw new Error(`Build the Rust release runtime first; missing ${name}.`);
  externs.push('--extern', `${name}=${files[0].path}`);
}
const probe = String.raw`
#[path = "resources.rs"] mod resources;
use resources::{ResourceScheduler, ResourceRequest, now_ms};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
fn request(id: &str) -> ResourceRequest {
    serde_json::from_value(json!({"id":id,"resource":"search","sessionId":id,"rootSessionId":id,
        "ownerId":"probe","runId":"run","epoch":"1","expiresAt":now_ms()+300_000,"timeoutMs":30_000})).unwrap()
}
#[cfg(synax_current)]
async fn wait(scheduler: Arc<ResourceScheduler>, request: ResourceRequest) {
    assert_eq!(scheduler.wait(request, 5_000).await.unwrap().state,"running");
}
#[cfg(not(synax_current))]
async fn wait(scheduler: Arc<ResourceScheduler>, request: ResourceRequest) {
    while scheduler.request(request.clone()).unwrap().state=="queued" {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
fn churn(count: usize)->Value {
    let scheduler=ResourceScheduler::default();let at=Instant::now();let mut completed=0;let mut error=None;
    for index in 0..count {
        let request=request(&format!("churn-{index}"));
        match scheduler.request(request.clone()) {
            Ok(status)=>{assert_eq!(status.state,"running");scheduler.release(&request.id,"probe").unwrap();completed+=1;},
            Err(failure)=>{error=Some(failure);break;}
        }
    }
    json!({"attempts":count,"completed":completed,"elapsedMs":at.elapsed().as_secs_f64()*1000.0,"error":error})
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    let mut latencies=Vec::new();
    for _ in 0..25 {
        let scheduler=Arc::new(ResourceScheduler::default());
        for index in 0..4 {scheduler.request(request(&format!("busy-{index}"))).unwrap();}
        let queued=request("waiting");
        assert_eq!(scheduler.request(queued.clone()).unwrap().state,"queued");
        let waiting=tokio::spawn(wait(scheduler.clone(),queued));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let at=Instant::now();scheduler.release("busy-0","probe").unwrap();
        waiting.await.unwrap();latencies.push(at.elapsed().as_secs_f64()*1000.0);
    }
    latencies.sort_by(f64::total_cmp);
    let percentile=|p:f64|latencies[((latencies.len() as f64*p).ceil() as usize).saturating_sub(1)];
    println!("{}",json!({"readyToObservedMs":{"p50":percentile(0.5),"p95":percentile(0.95),"p99":percentile(0.99),"samples":latencies.len()},
        "lowLoad":churn(500),"highTurnover":churn(10_000)}));
}
`;
try {
  const results = {};
  for (const [name, source] of [['baseline', baseline], ['current', current]]) {
    await writeFile(path.join(root, 'resources.rs'), source);
    await writeFile(path.join(root, 'probe.rs'), probe);
    const binary = path.join(root, name);
    execFileSync('rustc', ['--edition=2024', '-O', '-Awarnings', ...(name === 'current' ? ['--cfg', 'synax_current'] : []),
      path.join(root, 'probe.rs'), '-L', `dependency=${deps}`, ...externs, '-o', binary], { stdio: ['ignore', 'ignore', 'pipe'] });
    results[name] = [];
    for (let repeat = 0; repeat < 3; repeat++) results[name].push(JSON.parse(execFileSync(binary, [], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, SYNAX_RESOURCE_SEARCH_LIMIT: '4' },
    })));
  }
  const report = { createdAt: new Date().toISOString(), platform: `${os.platform()}-${os.arch()}`,
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    baselineSourceHash: createHash('sha256').update(baseline).digest('hex'), currentSourceHash: createHash('sha256').update(current).digest('hex'),
    scope: 'Optimized isolated resource scheduler; baseline reproduces the former 100 ms provider admission poll. Excludes HTTP, workers, UI, provider network and model latency.', results };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
