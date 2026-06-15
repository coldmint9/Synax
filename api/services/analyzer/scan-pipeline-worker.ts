import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { CodeMapScanRequest, CodeMapScanResult } from '../contracts/code-map.js';
import { sendToParent } from '../../lib/ipc/child-forward.js';
import { deliverScanProgress } from './scan-progress.js';
import { logger } from '../../lib/logger.js';
import type { NormalizedScanRequest } from './scan.js';
import type { ScanPipelineWorkerRequest, ScanPipelineWorkerResponse } from './scan-pipeline-messages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_DEV = fs.existsSync(path.join(__dirname, 'scan-pipeline-worker.thread.ts'));
const WORKER_SCRIPT = IS_DEV
  ? path.join(__dirname, 'worker-bootstrap.ts')
  : path.join(__dirname, 'scan-pipeline-worker.thread.js');
const ACTUAL_WORKER = path.join(__dirname, 'scan-pipeline-worker.thread.ts');

const SCAN_TIMEOUT_MS = 30 * 60 * 1000;

interface PendingScan {
  req: CodeMapScanRequest;
  normalized: NormalizedScanRequest;
  resolve: (result: CodeMapScanResult) => void;
  reject: (err: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

class ScanPipelineFacade {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pendingById = new Map<number, PendingScan>();
  private readonly queue: PendingScan[] = [];
  private draining = false;
  private activeProjectId: string | null = null;

  private forwardProgress(msg: Extract<ScanPipelineWorkerResponse, { type: 'scan:progress' }>): void {
    const payload = {
      message: msg.message,
      pct: msg.pct,
      completed: msg.completed,
      total: msg.total,
      projectId: msg.projectId ?? this.activeProjectId ?? undefined,
    };
    if (process.env.SYNAX_WIKI_JOB_CHILD === '1') {
      sendToParent({ type: 'scan:progress', ...payload });
      return;
    }
    deliverScanProgress(payload);
  }

  async run(req: CodeMapScanRequest, normalized: NormalizedScanRequest): Promise<CodeMapScanResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, normalized, resolve, reject });
      void this.drain();
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const workerOptions: import('node:worker_threads').WorkerOptions = IS_DEV
      ? { execArgv: ['--import', 'tsx/esm'], workerData: { __workerPath: ACTUAL_WORKER } }
      : {};

    const worker = new Worker(WORKER_SCRIPT, workerOptions);
    worker.on('message', (msg: ScanPipelineWorkerResponse) => {
      if (msg.type === 'scan:progress') {
        this.forwardProgress(msg);
        return;
      }
      this.handleMessage(msg);
    });
    worker.on('error', (err) => this.failAll(err));
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.failAll(new Error(`scan pipeline worker exited with code ${code}`));
      }
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private handleMessage(msg: ScanPipelineWorkerResponse): void {
    const pending = this.pendingById.get(msg.id);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingById.delete(msg.id);

    if (msg.type === 'scan:done') {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error));
    }

    this.activeProjectId = null;
    this.draining = false;
    void this.drain();
  }

  private failAll(err: Error): void {
    for (const pending of this.pendingById.values()) {
      pending.reject(err);
    }
    this.pendingById.clear();
    for (const pending of this.queue) {
      pending.reject(err);
    }
    this.queue.length = 0;
    this.draining = false;
    this.worker = null;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    this.draining = true;

    const job = this.queue.shift();
    if (!job) {
      this.draining = false;
      return;
    }

    const id = this.nextId++;
    this.pendingById.set(id, job);
    this.activeProjectId = job.req.projectId;

    const worker = this.ensureWorker();
    const payload: ScanPipelineWorkerRequest = {
      type: 'scan',
      id,
      req: job.req,
      normalized: job.normalized,
    };

    job.timeout = setTimeout(() => {
      if (!this.pendingById.has(id)) return;
      this.pendingById.delete(id);
      job.reject(new Error(`code map scan timed out after ${SCAN_TIMEOUT_MS}ms`));
      void worker.terminate();
      this.worker = null;
      this.draining = false;
      void this.drain();
    }, SCAN_TIMEOUT_MS);

    worker.postMessage(payload);
  }
}

const facade = new ScanPipelineFacade();

export function runCodeMapScanOffThread(
  req: CodeMapScanRequest,
  normalized: NormalizedScanRequest,
): Promise<CodeMapScanResult> {
  logger.info('[analyzer] dispatching scan to worker thread', { projectId: req.projectId });
  return facade.run(req, normalized);
}
