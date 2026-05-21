// ---------------------------------------------------------------------------
// api/services/wiki/__tests__/wiki-agent-service.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NoObjectGeneratedError } from 'ai';
import type { CodeMapScanResult } from '../../contracts/code-map.js';

let nanoidCounter = 0;
const mockGenerateGatewayObject = vi.fn();
const mockWarn = vi.fn();

vi.mock('nanoid', () => ({
  nanoid: () => `generated-${++nanoidCounter}`,
}));

vi.mock('../../llm-runtime/stream.js', () => ({
  generateGatewayObject: (...args: unknown[]) => mockGenerateGatewayObject(...args),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
  },
}));

import { wikiAgentService } from '../wiki-agent-service.js';

function makeScan(): CodeMapScanResult {
  return {
    scanId: 'scan-1',
    codeIndex: {
      files: [
        {
          id: 'file-1',
          path: 'src/index.ts',
          language: 'typescript',
          sha: 'sha-file-1',
          size: 100,
          symbolIds: ['sym-1'],
          chunkIds: [],
        },
        {
          id: 'file-2',
          path: 'api/server.ts',
          language: 'typescript',
          sha: 'sha-file-2',
          size: 200,
          symbolIds: [],
          chunkIds: [],
        },
      ],
      symbols: [
        {
          id: 'sym-1',
          fileId: 'file-1',
          kind: 'function',
          name: 'bootstrap',
          qualifiedName: 'src/index.ts::bootstrap',
          signature: '() => void',
          range: { startLine: 1, endLine: 10 },
          dependsOn: [],
          dependedBy: [],
        },
      ],
      chunks: [],
    },
    semanticGraph: {
      nodes: [
        { id: 'node-1', label: 'API', kind: 'module', summary: 'HTTP entrypoints' },
      ],
      edges: [],
    },
    moduleMap: {
      topDirs: [
        { path: 'api', fileCount: 1, symbolCount: 0 },
        { path: 'src', fileCount: 1, symbolCount: 1 },
      ],
    },
    communities: [
      { id: 'community-1', label: 'core', summary: 'Core runtime', fileCount: 2 },
    ],
  } as unknown as CodeMapScanResult;
}

function makeSchemaMismatchError(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: response did not match schema.',
    cause: new Error('schema mismatch'),
    text,
    response: {
      id: 'resp-1',
      modelId: 'test-model',
      timestamp: new Date(),
      headers: {},
    } as any,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    } as any,
    finishReason: 'stop',
  });
}

describe('wikiAgentService.generateWiki', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nanoidCounter = 0;
  });

  it('normalizes model output and generates system ids instead of requiring agent ids', async () => {
    mockGenerateGatewayObject.mockResolvedValueOnce({
      documents: [
        {
          title: 'Tech Stack',
          docType: 'tech stack',
          sortOrder: '2',
          blocks: [
            {
              blockType: 'text',
              content: 'Uses TypeScript across the API runtime.',
              sourceHints: ['src/index.ts'],
              confidence: '0.9',
            },
            {
              blockType: 'bullets',
              content: '- api/server.ts\n- src/index.ts',
              sourceHints: 'api/server.ts',
            },
          ],
        },
      ],
    });

    const result = await wikiAgentService.generateWiki(makeScan(), { locale: 'en', projectId: 'proj-1' });

    const request = mockGenerateGatewayObject.mock.calls[0][0];
    expect(request.messages.map((message: { content: string }) => message.content).join('\n')).toContain('json');
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].id).toMatch(/^generated-\d+$/);
    expect(result.documents[0].docType).toBe('tech_stack');
    expect(result.documents[0].sortOrder).toBe(2);
    expect(result.documents[0].blocks[0].id).toMatch(/^generated-\d+$/);
    expect(result.documents[0].blocks[0].blockType).toBe('paragraph');
    expect(result.documents[0].blocks[0].content).toEqual({
      text: 'Uses TypeScript across the API runtime.',
    });
    expect(result.documents[0].blocks[0].confidence).toBe(0.9);
    expect(result.documents[0].blocks[1].blockType).toBe('list');
    expect(result.documents[0].blocks[1].content).toEqual({
      items: ['api/server.ts', 'src/index.ts'],
      ordered: false,
    });
  });

  it('recovers from schema mismatch when the raw JSON text is still salvageable', async () => {
    mockGenerateGatewayObject.mockRejectedValueOnce(
      makeSchemaMismatchError(JSON.stringify({
        documents: [
          {
            title: 'Overview',
            docType: 'overview',
            blocks: [
              {
                blockType: 'paragraph',
                content: { text: 'Recovered from raw JSON.' },
                sourceHints: ['src/index.ts'],
              },
            ],
          },
        ],
      })),
    );

    const result = await wikiAgentService.generateWiki(makeScan(), { locale: 'en', projectId: 'proj-1' });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toBe('Overview');
    expect(result.documents[0].blocks[0].content).toEqual({ text: 'Recovered from raw JSON.' });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', cause: 'No object generated: response did not match schema.' }),
      'wiki generator: recovered structured output after schema mismatch',
    );
  });

  it('falls back to analyzer-derived wiki when recovery is impossible', async () => {
    mockGenerateGatewayObject.mockRejectedValueOnce(new Error('upstream failed'));

    const result = await wikiAgentService.generateWiki(makeScan(), { locale: 'en', projectId: 'proj-1' });

    expect(result.documents).toHaveLength(3);
    expect(result.documents.map(doc => doc.docType)).toEqual(['overview', 'architecture', 'tech_stack']);
    expect(result.documents[0].blocks[0].content).toEqual({
      text: expect.stringContaining('generated from static analysis data'),
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
      'wiki generator: falling back to analyzer-derived wiki draft',
    );
  });
});
