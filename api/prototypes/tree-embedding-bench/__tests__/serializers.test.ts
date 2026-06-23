import { describe, expect, it } from 'vitest';

import { serializeSymbolContext } from '../serializers.js';
import type { SymbolContext } from '../contracts.js';

function ctx(partial: Partial<SymbolContext> & Pick<SymbolContext, 'symbol' | 'file'>): SymbolContext {
  return {
    callees: [],
    callers: [],
    imports: [],
    ...partial,
  };
}

describe('serializeSymbolContext', () => {
  const base = ctx({
    symbol: {
      id: 'sym_1',
      fileId: 'file_1',
      kind: 'function',
      name: 'validateToken',
      qualifiedName: 'auth.ts:validateToken',
      range: { startLine: 1, endLine: 8 },
      signature: 'export function validateToken(token: string, secret: string): boolean {',
    },
    file: { id: 'file_1', path: 'auth.ts', language: 'typescript', size: 100, sha: 'abc' },
  });

  it('signature 策略优先输出 signature 文本', () => {
    const text = serializeSymbolContext(base, 'signature');
    expect(text).toContain('validateToken');
    expect(text).not.toContain('kind:');
  });

  it('symbol-card 包含结构化字段', () => {
    const text = serializeSymbolContext(base, 'symbol-card');
    expect(text).toContain('kind: function');
    expect(text).toContain('path: auth.ts');
    expect(text).toContain('name: validateToken');
  });

  it('skeleton 输出 AST 骨架而非完整源码块', () => {
    const text = serializeSymbolContext(base, 'skeleton');
    expect(text).toContain('ast: function_declaration');
    expect(text).toContain('symbol: validateToken');
  });

  it('graph-context 附加调用图信息', () => {
    const rich = ctx({
      ...base,
      callees: ['decodePayload', 'verifySignature'],
      callers: ['searchWithAuth'],
      imports: ['./auth.js'],
    });
    const text = serializeSymbolContext(rich, 'graph-context');
    expect(text).toContain('calls: decodePayload, verifySignature');
    expect(text).toContain('called_by: searchWithAuth');
    expect(text).toContain('imports: ./auth.js');
  });
});
