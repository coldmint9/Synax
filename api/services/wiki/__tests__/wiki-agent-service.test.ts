import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CodeMapScanResult } from '../../contracts/code-map.js';

const mockGenerateGatewayObject = vi.fn();
const mockWarn = vi.fn();

vi.mock('../../llm-runtime/gateway.js', () => ({
  generateGatewayObject: (...args: unknown[]) => mockGenerateGatewayObject(...args),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));

import { wikiAgentService } from '../wiki-agent-service.js';

function makeScan(): CodeMapScanResult {
  return {
    scanId: 'scan-1',
    codeIndex: {
      files: [{ id: 'file-1', path: 'src/index.ts', language: 'typescript', sha: 'sha', size: 100, symbolIds: [], chunkIds: [] }],
      symbols: [],
      chunks: [],
    },
    semanticGraph: { nodes: [], edges: [] },
    moduleMap: { languages: [{ language: 'typescript', fileCount: 1 }], topDirs: [] },
    communities: [],
  } as unknown as CodeMapScanResult;
}

describe('wikiAgentService.generateWiki', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns markdown documents from the model', async () => {
    mockGenerateGatewayObject.mockResolvedValueOnce({
      documents: [{
        title: 'Overview',
        docType: 'landscape',
        markdown: '# Overview\n\n## Stack\n\n| Layer | Notes |\n| --- | --- |\n| API | ts |\n',
        references: [{ filePath: 'src/index.ts' }],
      }],
    });

    const result = await wikiAgentService.generateWiki(makeScan(), { projectId: 'proj-1' });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].markdown).toContain('# Overview');
  });

  it('falls back when generation fails', async () => {
    mockGenerateGatewayObject.mockRejectedValueOnce(new Error('upstream failed'));
    const result = await wikiAgentService.generateWiki(makeScan(), { projectId: 'proj-1' });
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.documents[0].references.length).toBeGreaterThan(0);
    expect(mockWarn).toHaveBeenCalled();
  });
});
