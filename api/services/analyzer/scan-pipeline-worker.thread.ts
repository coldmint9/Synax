import { parentPort } from 'node:worker_threads';
import type { ScanPipelineWorkerRequest, ScanPipelineWorkerResponse } from './scan-pipeline-messages.js';

if (!parentPort) {
  throw new Error('scan-pipeline-worker.thread must run inside a worker_threads Worker');
}

parentPort.on('message', (msg: ScanPipelineWorkerRequest) => {
  if (msg.type !== 'scan') return;

  void (async () => {
    try {
      const { runCodeMapScanCore } = await import('./scan.js');
      const result = await runCodeMapScanCore(msg.req, msg.normalized);
      const response: ScanPipelineWorkerResponse = { type: 'scan:done', id: msg.id, result };
      parentPort!.postMessage(response);
    } catch (err) {
      const response: ScanPipelineWorkerResponse = {
        type: 'scan:error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort!.postMessage(response);
    }
  })();
});
