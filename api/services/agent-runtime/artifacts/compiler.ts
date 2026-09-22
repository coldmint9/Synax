import {htmlIconRuntime} from "./html-icons.js";
import { visualizationStyles } from "./visualize-runtime.js";
import os from 'node:os';
import { createRequire } from 'node:module';
import type { DefaultTreeAdapterMap } from 'parse5';
import { Worker } from 'node:worker_threads';
import { ArtifactError, ARTIFACT_LIMITS, type ArtifactFile, type ArtifactKind } from './contracts.js';
import { buildWorkerSource } from './build-worker.js';
import { compileHtml, runtimeDocument, validateResource } from './policy.js';
import { type SnapshotReader } from './snapshot.js';
import { hash } from './validation.js';
import { installedDependencies, type ArtifactDependency } from './dependencies.js';
export type { ArtifactDependency } from './dependencies.js';

export interface Compilation { html: string; source: ArtifactFile[]; sourceHash: string; bundleHash: string; dependencies: ArtifactDependency[] }
const hostRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
let activeBuilds = 0;
/** Deadline covers the entire build, not each individual stylesheet/script. */
export async function compileArtifact(snapshot: SnapshotReader, kind: ArtifactKind, options: { signal?: AbortSignal; timeoutMs?: number; sdkSource?: string } = {}): Promise<Compilation> {
  if (activeBuilds >= 2) throw new ArtifactError('BUILD_BUSY', 'Artifact compiler concurrency limit reached; try again.', 429);
  if (options.signal?.aborted) throw new ArtifactError('BUILD_CANCELLED', 'Artifact build was cancelled.', 499);
  activeBuilds++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let failure: ArtifactError | undefined;
  const parseRequests = new Map<number, { resolve: (document: DefaultTreeAdapterMap['document']) => void; reject: (error: Error) => void }>();
  const requests = new Map<number, { resolve: (result: { js: string; css: string }) => void; reject: (error: Error) => void }>();
  try {
    const deps = installedDependencies(hostRequire);
    worker = new Worker(buildWorkerSource, {
      eval: true, name: 'artifact-compiler', resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      workerData: { dependencies: deps.entries, modulesRoot: deps.modulesRoot, esbuildPath: deps.esbuildPath, parse5Path: deps.parse5Path, packageRoots: deps.packageRoots, workingDirectory: os.tmpdir() },
      // Do not forward Node preload hooks from the application into the worker.
      execArgv: [],
    });
    const stop = (error: ArtifactError) => {
      failure ??= error;
      for (const request of requests.values()) request.reject(error);
      requests.clear();
      for (const request of parseRequests.values()) request.reject(error);
      parseRequests.clear();
      void worker?.terminate();
    };
    timer = setTimeout(() => stop(new ArtifactError('BUILD_TIMEOUT', 'Artifact build exceeded its time limit.', 408)), options.timeoutMs ?? ARTIFACT_LIMITS.buildMs);
    abort = () => stop(new ArtifactError('BUILD_CANCELLED', 'Artifact build was cancelled.', 499));
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', () => stop(new ArtifactError('RESOURCE_LIMIT', 'Artifact compiler worker failed or exhausted its memory limit.')));
    worker.on('exit', code => { if (code !== 0 && !failure) stop(new ArtifactError('INVALID_SOURCE', 'Artifact compiler stopped before completing.')); });
    worker.on('message', message => {
      if (failure) return;
      if (message.type === 'read') {
        try { const file = snapshot.resolve(message.importer, message.reference); validateResource(file); worker!.postMessage({ type: 'file', id: message.id, file }); }
        catch (error) { const e = error instanceof ArtifactError ? error : new ArtifactError('INVALID_SOURCE', 'Resource could not be snapshotted.'); worker!.postMessage({ type: 'file', id: message.id, error: { code: e.code, message: e.message } }); }
        return;
      }
      const parsing = parseRequests.get(message.id);
      if (parsing) {
        parseRequests.delete(message.id);
        if (message.type === 'parsed') parsing.resolve(message.document);
        else parsing.reject(new ArtifactError(message.code, message.message));
        return;
      }
      const request = requests.get(message.id); if (!request) return;
      requests.delete(message.id);
      if (message.type === 'built') request.resolve({ js: message.js, css: message.css });
      else {
        // Never return host module paths (or the authorized workspace root) to clients.
        const messageText = String(message.message).split(snapshot.root).join('[workspace]').split(deps.modulesRoot).join('[dependencies]').replace(/(?:[A-Za-z]:)?\/(?:Users|home|tmp|private|var)\/[^\s:]+/g, '[host-path]');
        request.reject(new ArtifactError(message.code === 'PATH_OUTSIDE_WORKSPACE' ? message.code : ['UNSUPPORTED_IMPORT','POLICY_BLOCKED','RESOURCE_LIMIT'].includes(message.code) ? message.code : 'INVALID_SOURCE', messageText));
      }
    });
    let id = 0;
    const compile = (entry: ArtifactFile, options?: { classic?: boolean }): Promise<{ js: string; css: string }> => {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { const next = ++id; requests.set(next, { resolve, reject }); worker!.postMessage({ type: 'build', id: next, entry, classic: options?.classic ?? false }); });
    };
    const parseHtml = (source: string): Promise<DefaultTreeAdapterMap['document']> => {
      if (failure) return Promise.reject(failure);
      // Cap main-thread structured-clone/traversal overhead as well as worker memory.
      if ((source.match(/</g)?.length ?? 0) > 10000) return Promise.reject(new ArtifactError('RESOURCE_LIMIT', 'HTML markup complexity limit exceeded.'));
      return new Promise((resolve, reject) => { const next = ++id; parseRequests.set(next, { resolve, reject }); worker!.postMessage({type:'parse',id:next,source}); });
    };
    // Dynamic import permits independent SDK development; production never substitutes a stub.
    const sdk = options.sdkSource ?? (await import('./runtime-sdk.js')).artifactSdkSource();
    const hostStyles = visualizationStyles();
    let html: string;
    if (kind === 'html') html = await compileHtml(snapshot, compile, sdk + '\n' + htmlIconRuntime(deps.entries['lucide-react']), parseHtml, [hostStyles]);
    else {
      const entry = snapshot.read(snapshot.entry);
      if (!/\.(?:tsx?|jsx?|mjs)$/i.test(entry.path)) throw new ArtifactError('INVALID_SOURCE', 'React entry must be a JS/TS module.');
      // A default-exported component is the entry contract; workspace bootstraps/configs never run.
      const result = await compile({ path: '__synax_entry__.tsx', content: `import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify('./' + entry.path)};createRoot(document.getElementById('root')).render(React.createElement(App));`, encoding: 'utf8', mediaType: 'text/typescript' });
      html = runtimeDocument('<div id="root"></div>', [result.js], [hostStyles, ...(result.css ? [result.css] : [])], sdk);
    }
    if (failure) throw failure;
    if (options.signal?.aborted) throw new ArtifactError('BUILD_CANCELLED', 'Artifact build was cancelled.', 499);
    snapshot.verify();
    if (Buffer.byteLength(html) > ARTIFACT_LIMITS.bundleBytes) throw new ArtifactError('RESOURCE_LIMIT', 'Compiled artifact bundle size limit exceeded.');
    const source = snapshot.files();
    return { html, source, sourceHash: hash(JSON.stringify(source)), bundleHash: hash(html), dependencies: deps.licenses };
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
    if (worker) await worker.terminate();
    activeBuilds--;
  }
}
