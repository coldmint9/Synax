// ---------------------------------------------------------------------------
// Search contract mirror for the built-in analyzer
// ---------------------------------------------------------------------------

export type SearchMode = 'keyword' | 'hybrid';

export interface Range {
  startLine: number;
  endLine: number;
}

export interface SearchHit {
  id: string;
  kind: 'chunk' | 'symbol' | 'file';
  score: number;
  filePath: string;
  range: Range;
  preview: string;
  symbolIds: string[];
  /** 命中来源，去向量化后仅保留 graph / keyword / hybrid。 */
  provenance?: 'graph' | 'keyword' | 'hybrid';
}

export interface HybridResult {
  query: string;
  mode: SearchMode;
  hits: SearchHit[];
}

export interface MountHint {
  nodeId?: string;
  suggestedParentId: string;
  suggestedType: 'feature' | 'goal' | 'action';
  label: string;
  rationale: string;
  score: number;
}
