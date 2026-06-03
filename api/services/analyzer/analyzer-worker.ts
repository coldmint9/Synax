/**
 * Worker thread entry point for code analysis.
 *
 * Receives file paths from the main thread, reads and parses each file
 * (including tree-sitter parsing), and returns structured results.
 * All heavy synchronous work (I/O + tree-sitter parsing) runs on the
 * worker's own thread, keeping the main event loop responsive.
 */

import { parentPort } from 'node:worker_threads';
import { parseOneFile } from './parse-lib.js';

interface WorkerRequest {
	id: number;
	absPath: string;
	workDirAbs: string;
}

interface WorkerResponse {
	id: number;
	result?: ReturnType<typeof parseOneFile> extends Promise<infer T> ? T : never;
	error?: string;
}

if (!parentPort) {
	throw new Error('analyzer-worker.ts must be run as a worker thread.');
}

parentPort.on('message', async (msg: WorkerRequest) => {
	const response: WorkerResponse = { id: msg.id };

	try {
		const result = await parseOneFile(msg.absPath, msg.workDirAbs);
		response.result = result;
	} catch (err) {
		response.error = err instanceof Error ? err.message : String(err);
	}

	parentPort!.postMessage(response);
});
