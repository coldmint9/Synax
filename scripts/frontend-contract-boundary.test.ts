import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Type-only imports still pull implementation dependencies into the TypeScript program.
// Browser contracts must not drag in SQLite, session stores or runtime transactions.
describe('frontend runtime contract boundary', () => {
  it('keeps server persistence and live bus implementations out of the browser type graph', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const entry = path.join(root, 'client/src/adapters/transport/agentRuntime.ts');
    const program = ts.createProgram([entry], {
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    });
    expect(program.getSourceFile(entry)).toBeDefined();
    const serverFiles = program.getSourceFiles().map(file => path.relative(root, file.fileName).replaceAll('\\', '/')).filter(file =>
      /^services\/local-node\/infrastructure\/database\//.test(file) || /^services\/local-node\/modules\/agent-runtime\/(session-store|runtime-transaction|session-live-bus|runtime-bus-bridge)\./.test(file),
    );
    expect(serverFiles).toEqual([]);
  });
});
