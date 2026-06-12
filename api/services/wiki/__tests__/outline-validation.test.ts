import { describe, it, expect } from 'vitest';
import {
  validateStructure,
  validateFilePaths,
  validatePackageCoverage,
  validateKeyQuestions,
  validateDocTypeMix,
  fullValidation,
  blockingErrors,
} from '../tools/outline-validation.js';
import type { WikiOutlineEntry } from '../tools/contracts.js';
import type { PackageBaseline } from '../tools/package-baseline.js';

const q = (s: string) => `What is the exact behavior of ${s} at runtime?`;

function doc(partial: Partial<WikiOutlineEntry> & { id: string }): WikiOutlineEntry {
  return {
    docType: 'module',
    title: partial.id,
    targetFiles: [],
    keyQuestions: [q('a'), q('b')],
    ...partial,
  } as WikiOutlineEntry;
}

function baseOutline(): WikiOutlineEntry[] {
  return [
    doc({ id: 'landscape', docType: 'landscape', targetFiles: ['src/auth/login.ts'] }),
    doc({ id: 'topology', docType: 'topology', targetFiles: ['src/auth/login.ts'] }),
    doc({ id: 'mod-auth', docType: 'module', targetFiles: ['src/auth/login.ts'] }),
    doc({ id: 'flow-login', docType: 'flow', targetFiles: ['src/auth/login.ts'] }),
  ];
}

const validPaths = new Set(['src/auth/login.ts', 'src/db/schema.ts']);

const authPkg: PackageBaseline = {
  id: 'pkg:src-auth',
  label: 'src/auth',
  dirPath: 'src/auth',
  fileIds: ['f1'],
  fileCount: 5,
  symbolCount: 20,
  hubSymbols: [],
};

describe('validateStructure', () => {
  it('requires landscape and topology', () => {
    const errors = validateStructure([doc({ id: 'a' })]);
    expect(errors.map(e => e.message).join(' ')).toMatch(/landscape/);
    expect(errors.map(e => e.message).join(' ')).toMatch(/topology/);
  });

  it('passes a well-formed outline', () => {
    expect(validateStructure(baseOutline())).toEqual([]);
  });
});

describe('validateFilePaths', () => {
  it('flags non-existent targetFiles', () => {
    const outline = [doc({ id: 'a', targetFiles: ['nope.ts'] })];
    const errors = validateFilePaths(outline, validPaths);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('targetFiles');
  });
});

describe('validatePackageCoverage', () => {
  it('flags core packages not covered by any module doc', () => {
    const outline = baseOutline().filter(d => d.id !== 'mod-auth');
    const errors = validatePackageCoverage(outline, [authPkg]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('coverage');
  });

  it('passes when a module doc targets files inside the package', () => {
    expect(validatePackageCoverage(baseOutline(), [authPkg])).toEqual([]);
  });
});

describe('validateKeyQuestions', () => {
  it('requires at least 2 questions', () => {
    const errors = validateKeyQuestions([doc({ id: 'a', keyQuestions: [q('x')] })]);
    expect(errors).toHaveLength(1);
  });

  it('rejects vague one-word questions', () => {
    const errors = validateKeyQuestions([doc({ id: 'a', keyQuestions: ['why?', 'how?'] })]);
    expect(errors).toHaveLength(1);
  });
});

describe('validateDocTypeMix', () => {
  it('warns when there is no flow document', () => {
    const outline = baseOutline().filter(d => d.docType !== 'flow');
    const errors = validateDocTypeMix(outline, validPaths);
    expect(errors.some(e => e.severity === 'warning' && /flow/.test(e.message))).toBe(true);
  });

  it('warns when a storage layer exists but no data doc', () => {
    const errors = validateDocTypeMix(baseOutline(), validPaths);
    expect(errors.some(e => /data document/.test(e.message))).toBe(true);
  });
});

describe('fullValidation + blockingErrors', () => {
  it('warnings do not block', () => {
    const all = fullValidation(baseOutline(), validPaths, { corePackages: [authPkg], strictQuality: true });
    expect(all.some(e => e.severity === 'warning')).toBe(true);
    expect(blockingErrors(all)).toEqual([]);
  });

  it('strict mode surfaces keyQuestion errors as blocking', () => {
    const outline = baseOutline().map(d => ({ ...d, keyQuestions: [] }));
    const all = fullValidation(outline, validPaths, { strictQuality: true });
    expect(blockingErrors(all).length).toBeGreaterThan(0);
  });
});
