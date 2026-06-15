import type { CodeMapScanRequest, CodeMapScanResult } from '../contracts/code-map.js';
import type { NormalizedScanRequest } from './scan.js';

export type ScanPipelineWorkerRequest = {
  type: 'scan';
  id: number;
  req: CodeMapScanRequest;
  normalized: NormalizedScanRequest;
};

export type ScanPipelineWorkerResponse =
  | { type: 'scan:done'; id: number; result: CodeMapScanResult }
  | { type: 'scan:error'; id: number; error: string }
  | { type: 'scan:progress'; message: string; pct?: number; completed?: number; total?: number; projectId?: string };
