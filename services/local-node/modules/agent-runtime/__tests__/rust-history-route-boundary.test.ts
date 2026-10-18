import fs from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('has no old history imports or selectable runtime in HTTP routes', () => {
  const source = fs.readFileSync(new URL('../../../transport/http/agent-runtime.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('agent-runtime.ts', source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require')) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(imports.filter(path => /flat-history|simple-history|transcript-jsonl|checkpoints\//.test(path))).toEqual([]);
  expect(source).not.toMatch(/loadLegacy|streamMode\(|history\/upgrade/);
});

it('central execution repositories contain no SQL or old history backends', () => {
  for (const file of ['session-store.ts','session-runtime.ts','work-store.ts','plan-artifact-store.ts','usage-projection.ts','runtime-history.ts','runtime-transaction.ts']) {
    const source = fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    expect(source, file).not.toMatch(/getRawSqlite|versionedSession|transcriptRepository|loadLegacy|checkpoints\/|agent_runtime_/);
  }
});
