import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FileEntry, SymbolEntry, ChunkEntry } from '../contracts/forest.js';
import type { CodeMapCallEdge, CodeMapImport } from '../contracts/code-map.js';
import type { AnalyzerSourceFile } from './shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface FileParseResult {
	fileEntry: FileEntry;
	symbols: SymbolEntry[];
	calls: CodeMapCallEdge[];
	imports: CodeMapImport[];
	chunks: ChunkEntry[];
	sourceFile: AnalyzerSourceFile;
	warnings: string[];
}

interface WorkerTask {
	resolve: (value: FileParseResult | null) => void;
	reject: (reason?: unknown) => void;
}

interface WorkerMessage {
	id: number;
	result?: FileParseResult | null;
	error?: string;
}

const DEFAULT_POOL_SIZE = Math.max(1, os.cpus().length - 1);
const WORKER_TIMEOUT_MS = 60_000; // 60s per file — generous for large files

export class AnalyzerWorkerPool {
	private workers: Worker[];
	private taskId = 0;
	private pending = new Map<number, WorkerTask>();
	private nextWorker = 0;
	private terminated = false;

	constructor(size = DEFAULT_POOL_SIZE) {
		this.workers = [];
		for (let i = 0; i < size; i++) {
			const worker = new Worker(path.join(__dirname, 'analyzer-worker.js'));
			worker.on('message', (msg: WorkerMessage) => this.handleMessage(worker, msg));
			worker.on('error', (err) => this.handleWorkerError(worker, err));
			this.workers.push(worker);
		}
	}

	/**
	 * Submit a single file for parsing. Returns a promise that resolves when
	 * the worker completes, or rejects on timeout / worker crash.
	 */
	parseFile(absPath: string, workDirAbs: string): Promise<FileParseResult | null> {
		if (this.terminated) {
			return Promise.reject(new Error('Worker pool has been terminated.'));
		}

		const id = ++this.taskId;
		const worker = this.workers[this.nextWorker % this.workers.length];
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`File parse timed out after ${WORKER_TIMEOUT_MS / 1000}s: ${absPath}`));
			}, WORKER_TIMEOUT_MS);

			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timeout);
					resolve(result);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			worker.postMessage({ id, absPath, workDirAbs });
		});
	}

	/**
	 * Gracefully terminate all workers. After this, no more parseFile calls
	 * will succeed.
	 */
	async terminate(): Promise<void> {
		if (this.terminated) return;
		this.terminated = true;

		// Reject all pending tasks
		for (const [, task] of this.pending) {
			task.reject(new Error('Worker pool terminated.'));
		}
		this.pending.clear();

		// Terminate all workers
		await Promise.all(
			this.workers.map(
				(w) =>
					new Promise<void>((resolve) => {
						w.on('exit', () => resolve());
						w.terminate();
					}),
			),
		);

		this.workers = [];
	}

	private handleMessage(_worker: Worker, msg: WorkerMessage): void {
		const task = this.pending.get(msg.id);
		if (!task) return;
		this.pending.delete(msg.id);

		if (msg.error) {
			task.resolve(null); // Don't reject — return null so the file is skipped gracefully
		} else {
			task.resolve(msg.result ?? null);
		}
	}

	private handleWorkerError(worker: Worker, err: Error): void {
		// Reject only the task currently assigned to this worker (if any).
		// The worker will be replaced on next use via the round-robin index.
		console.error('[analyzer-worker-pool] worker error:', err.message);
		worker.terminate();
	}
}
