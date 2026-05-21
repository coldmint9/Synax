import type {
  ChunkEntry,
  CoordEdge,
  CoordNode,
  FileEntry,
  ForestPatch,
  SemanticGraph,
  SourceBinding,
  SourceLink,
  SymbolEntry,
} from './forest.js';
export interface CodeMapImport {
  sourceFileId: string;
  targetModule: string;
  line: number;
  level: number;
  isExternal: boolean;
}

export interface CodeMapCodeIndex {
  indexId: string;
  files: FileEntry[];
  symbols: SymbolEntry[];
  chunks: ChunkEntry[];
  imports: CodeMapImport[];
  stats: {
    fileCount: number;
    symbolCount: number;
    chunkCount: number;
    importCount: number;
  };
  updatedAt: number;
}

export interface CodeMapLanguageSummary {
  language: string;
  fileCount: number;
  symbolCount: number;
  bytes: number;
}

export interface CodeMapModuleSummary {
  path: string;
  fileCount: number;
  symbolCount: number;
  languages: Record<string, number>;
  importsIn: number;
  importsOut: number;
  score: number;
}

export interface CodeMapFileSummary {
  fileId: string;
  path: string;
  language: string;
  symbolCount: number;
  importCount: number;
  score: number;
}

export interface CodeMapSymbolSummary {
  id: string;
  fileId: string;
  path: string;
  kind: string;
  name: string;
  qualifiedName: string;
  degree: number;
  centrality: number;
}

export interface CodeMapDependencySummary {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface CodeMapModuleMap {
  topDirs: CodeMapModuleSummary[];
  languages: CodeMapLanguageSummary[];
  entryFiles: CodeMapFileSummary[];
  coreSymbols: CodeMapSymbolSummary[];
  dependencies: CodeMapDependencySummary[];
}

export interface CodeMapCommunity {
  id: string;
  label: string;
  summary: string;
  fileIds: string[];
  symbolIds: string[];
  hubSymbols: CodeMapSymbolSummary[];
  score: number;
  fileCount: number;
  symbolCount: number;
}

export interface CodeMapCoordSeed {
  rootId: string;
  nodes: CoordNode[];
  edges: CoordEdge[];
  links: SourceLink[];
  patch: ForestPatch;
}

export interface CodeMapScanLimits {
  maxCommunities?: number;
  maxEntryFiles?: number;
  maxCoreSymbols?: number;
  maxDependencies?: number;
  maxActionsPerCommunity?: number;
  evidencePerFeature?: number;
}

export type CodeMapInclude = 'all' | 'module-map' | 'communities' | 'coord-seed';

export interface CodeMapScanRequest {
  projectId: string;
  source?: SourceBinding;
  workDir?: string;
  include?: CodeMapInclude[];
  limits?: CodeMapScanLimits;
}

export interface CodeMapScanResult {
  projectId: string;
  scanId: string;
  generatedAt: number;
  durationMs: number;
  workDir: string;
  source?: SourceBinding | null;
  codeIndex: CodeMapCodeIndex;
  semanticGraph: SemanticGraph;
  moduleMap?: CodeMapModuleMap | null;
  communities?: CodeMapCommunity[] | null;
  coordSeed?: CodeMapCoordSeed | null;
  warnings: string[];
}
