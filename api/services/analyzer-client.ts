// ---------------------------------------------------------------------------
// analyzer-client — Bun 侧本地 analyzer 适配层。
//
// 这个模块保留原有对外 API 形状，所有实现都委托给同仓库的
// Bun analyzer-service。
// ---------------------------------------------------------------------------

import type { CoordForest, SourceBinding } from './contracts/forest.js';
import type { HybridResult, MountHint, SearchMode } from './contracts/search.js';
import type { AgentLoopRecord, CoordinatesContextIndex, ContextBindingRelation, ContextSignalKind } from './contracts/context.js';
import type { CodeMapScanRequest, CodeMapScanResult } from './contracts/code-map.js';
import type { LocalAnalyzerEvent } from './analyzer-service.js';
import {
  buildLocalAnalyzerHealth,
  extractContextSignals as localExtractContextSignals,
  fetchForest as localFetchForest,
  scanCodeMap as localScanCodeMap,
  search as localSearch,
  streamAnalyzerSse,
  suggestMount as localSuggestMount,
} from './analyzer-service.js';

export interface AnalyzeRequest {
  projectId: string;
  source: SourceBinding;
}

export interface SearchRequest {
  projectId: string;
  query: string;
  mode?: SearchMode;
  topK?: number;
  alpha?: number;
}

export interface SuggestMountRequest {
  projectId: string;
  intent: string;
}

export interface ExtractedContextSignal {
  kind: ContextSignalKind;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  tags: string[];
  sourceLinks: string[];
}

export interface ExtractedContextHandoff {
  signalTitle: string;
  targetNodeId: string;
  relation: ContextBindingRelation;
  confidence: number;
  reason: string;
}

export interface ExtractContextSignalsRequest {
  projectId: string;
  loopRecord: AgentLoopRecord;
  forest: CoordForest;
  contextIndex: CoordinatesContextIndex;
  locale?: 'zh' | 'en';
  workDir?: string | null;
  model?: string;
}

export interface ExtractContextSignalsResponse {
  signals: ExtractedContextSignal[];
  handoffs: ExtractedContextHandoff[];
  warnings: string[];
}

export interface ScanDiffEntry {
  kind: 'file_added' | 'file_removed' | 'file_modified' | 'symbol_added' | 'symbol_removed' | 'symbol_modified' | 'community_shifted';
  entityId: string;
  path?: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  significance: number;
}

export interface ScanDiff {
  projectId: string;
  oldScanId: string;
  newScanId: string;
  oldSourceRevision?: string;
  newSourceRevision?: string;
  entries: ScanDiffEntry[];
  summary: string;
  stats: Record<string, number>;
}

export async function analyzerHealth(): Promise<{ ok: boolean; info?: unknown; error?: string }> {
  try {
    return { ok: true, info: buildLocalAnalyzerHealth() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function search(req: SearchRequest): Promise<HybridResult> {
  return localSearch(req);
}

export function suggestMount(req: SuggestMountRequest): Promise<{ hints: MountHint[] }> {
  return localSuggestMount(req);
}

export function fetchForest(projectId: string): Promise<CoordForest | null> {
  return localFetchForest(projectId);
}

export function scanCodeMap(req: CodeMapScanRequest): Promise<CodeMapScanResult> {
  return localScanCodeMap(req);
}

export function extractContextSignals(req: ExtractContextSignalsRequest): Promise<ExtractContextSignalsResponse> {
  return localExtractContextSignals(req);
}

export function createLocalAnalyzerStream(
  upstreamPath: '/analyze' | '/reanalyze' | '/review/goal',
  body: unknown,
): AsyncGenerator<LocalAnalyzerEvent> {
  return streamAnalyzerSse(upstreamPath, body);
}
