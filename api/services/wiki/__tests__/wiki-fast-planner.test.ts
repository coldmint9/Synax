import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CodeMapScanResult } from '../../contracts/code-map.js';

const mockGenerateGatewayObject = vi.fn();

vi.mock('../../llm-runtime/gateway.js', () => ({
  generateGatewayObject: (...args: unknown[]) => mockGenerateGatewayObject(...args),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { generateOutlineFast, sanitizeOutline } from '../wiki-fast-planner.js';

const q1 = 'What state transitions does the auth login flow have?';
const q2 = 'How are session tokens persisted and invalidated?';

function makeScan(): CodeMapScanResult {
  return {
    projectId: 'proj-1',
    scanId: 'scan-1',
    workDir: '/tmp/nonexistent-fast-planner-test',
    codeIndex: {
      indexId: 'idx-1',
      files: [
        { id: 'f1', path: 'src/auth/login.ts', language: 'typescript', sha: 'a', size: 100 },
        { id: 'f2', path: 'src/auth/session.ts', language: 'typescript', sha: 'b', size: 100 },
      ],
      symbols: [],
      chunks: [],
      imports: [],
      callEdges: [],
      stats: { fileCount: 2, symbolCount: 0, chunkCount: 0, importCount: 0, callEdgeCount: 0 },
      updatedAt: 0,
    },
    semanticGraph: { nodes: [], edges: [] },
    moduleMap: {
      topDirs: [],
      languages: [{ language: 'typescript', fileCount: 2, symbolCount: 0, bytes: 200 }],
      entryFiles: [],
      coreSymbols: [],
      dependencies: [],
    },
    communities: [],
    warnings: [],
    generatedAt: 0,
    durationMs: 0,
  } as unknown as CodeMapScanResult;
}

function validDocuments() {
  return [
    { id: 'landscape', docType: 'landscape', title: 'Project Landscape', targetFiles: ['src/auth/login.ts'], keyQuestions: [q1, q2] },
    { id: 'topology', docType: 'topology', title: 'Architecture', targetFiles: ['src/auth/login.ts'], keyQuestions: [q1, q2] },
    { id: 'mod-auth', docType: 'module', title: 'Auth', targetFiles: ['src/auth/login.ts', 'src/auth/session.ts'], keyQuestions: [q1, q2] },
    { id: 'flow-login', docType: 'flow', title: 'Login Flow', targetFiles: ['src/auth/login.ts'], keyQuestions: [q1, q2] },
  ];
}

const opts = { projectId: 'proj-1', workDir: '/tmp/nonexistent-fast-planner-test', locale: 'zh' as const };

describe('buildFastPlannerSystemPrompt locale', () => {
  it('includes English outline requirement when locale is en', async () => {
    const { buildFastPlannerSystemPrompt } = await import('../wiki-prompt-builder.js');
    const prompt = buildFastPlannerSystemPrompt('en');
    expect(prompt).toContain('English');
    expect(prompt).toContain('Outline Language');
  });

  it('includes Chinese outline requirement when locale is zh', async () => {
    const { buildFastPlannerSystemPrompt } = await import('../wiki-prompt-builder.js');
    const prompt = buildFastPlannerSystemPrompt('zh');
    expect(prompt).toContain('Chinese (Simplified)');
  });
});

describe('generateOutlineFast', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the outline when the first call passes validation', async () => {
    mockGenerateGatewayObject.mockResolvedValueOnce({ documents: validDocuments() });

    const result = await generateOutlineFast(makeScan(), opts);
    expect(result).not.toBeNull();
    expect(result!.repaired).toBe(false);
    expect(result!.outline).toHaveLength(4);
    expect(mockGenerateGatewayObject).toHaveBeenCalledTimes(1);
    const request = mockGenerateGatewayObject.mock.calls[0][0] as { purpose: string };
    expect(request.purpose).toBe('wiki-outline');
  });

  it('repairs once when the first outline fails validation', async () => {
    const broken = validDocuments().filter(d => d.docType !== 'topology');
    mockGenerateGatewayObject
      .mockResolvedValueOnce({ documents: broken })
      .mockResolvedValueOnce({ documents: validDocuments() });

    const result = await generateOutlineFast(makeScan(), opts);
    expect(result).not.toBeNull();
    expect(result!.repaired).toBe(true);
    expect(mockGenerateGatewayObject).toHaveBeenCalledTimes(2);

    const repairMessages = (mockGenerateGatewayObject.mock.calls[1][0] as { messages: { role: string; content: string }[] }).messages;
    expect(repairMessages.some(m => m.role === 'user' && m.content.includes('Validation Errors'))).toBe(true);
  });

  it('returns null when the repair attempt still fails validation', async () => {
    const broken = validDocuments().filter(d => d.docType !== 'landscape');
    mockGenerateGatewayObject
      .mockResolvedValueOnce({ documents: broken })
      .mockResolvedValueOnce({ documents: broken });

    const result = await generateOutlineFast(makeScan(), opts);
    expect(result).toBeNull();
    expect(mockGenerateGatewayObject).toHaveBeenCalledTimes(2);
  });

  it('returns null when the gateway call throws', async () => {
    mockGenerateGatewayObject.mockRejectedValueOnce(new Error('upstream failed'));
    const result = await generateOutlineFast(makeScan(), opts);
    expect(result).toBeNull();
  });

  it('sanitizes hallucinated targetFiles before validating', async () => {
    const docs = validDocuments();
    docs[2].targetFiles = ['src/auth/login.ts', 'made/up/path.ts'];
    mockGenerateGatewayObject.mockResolvedValueOnce({ documents: docs });

    const result = await generateOutlineFast(makeScan(), opts);
    expect(result).not.toBeNull();
    const mod = result!.outline.find(d => d.id === 'mod-auth')!;
    expect(mod.targetFiles).toEqual(['src/auth/login.ts']);
  });
});

describe('sanitizeOutline', () => {
  it('dedupes ids and strips invalid paths', () => {
    const valid = new Set(['a.ts']);
    const out = sanitizeOutline(
      [
        { id: 'dup', docType: 'module', title: 'A', targetFiles: ['a.ts', 'b.ts'], keyQuestions: [' q1 ', ''] },
        { id: 'dup', docType: 'module', title: 'B', targetFiles: [], keyQuestions: [] },
      ],
      valid,
    );
    expect(out.map(d => d.id)).toEqual(['dup', 'dup-x']);
    expect(out[0].targetFiles).toEqual(['a.ts']);
    expect(out[0].keyQuestions).toEqual(['q1']);
  });
});
