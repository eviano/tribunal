import { describe, it, expect } from 'vitest';
import { claimReconciliation } from '../src/analyzers/claimReconciliation';
import type { AnalyzerContext, ChangedFile, Claim, Finding } from '../src/types';

interface CtxSpec {
  changedFiles: Array<{ path: string; status?: ChangedFile['status']; addedLines?: number[] }>;
  files?: Record<string, string>;
  baseFiles?: Record<string, string>;
  base?: string;
  claims: Claim[];
}

function makeCtx(spec: CtxSpec): AnalyzerContext {
  const files = spec.files ?? {};
  const changedFiles: ChangedFile[] = spec.changedFiles.map((f) => {
    const content = files[f.path] ?? '';
    const lineCount = content.split('\n').length;
    const added = new Set(f.addedLines ?? Array.from({ length: lineCount }, (_, i) => i + 1));
    return { path: f.path, status: f.status ?? 'modified', addedLines: added };
  });
  return {
    repoRoot: '/virtual',
    base: spec.base,
    claims: spec.claims,
    changedFiles,
    readFile: (p) => files[p] ?? null,
    readBaseFile: spec.baseFiles ? (p) => spec.baseFiles![p] ?? null : undefined,
  };
}

function sole(spec: CtxSpec): Finding {
  const findings = claimReconciliation.run(makeCtx(spec));
  expect(findings).toHaveLength(1);
  return findings[0];
}

const claim = (key: string): Claim => ({ key, raw: key });

describe('claim-reconciliation · added-test', () => {
  it('PASS when the diff adds an asserting test', () => {
    const f = sole({
      claims: [claim('added-test')],
      changedFiles: [{ path: 'a.test.ts', status: 'added' }],
      files: { 'a.test.ts': `import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });` },
    });
    expect(f.verdict).toBe('PASS');
  });

  it('CONTRADICTED when claimed but the diff adds no test at all', () => {
    const f = sole({
      claims: [claim('added-test')],
      changedFiles: [{ path: 'src/foo.ts' }],
      files: { 'src/foo.ts': `export const x = 1;` },
    });
    expect(f.verdict).toBe('CONTRADICTED');
  });

  it('UNVERIFIED when a test was added but its assertion is undetectable', () => {
    const f = sole({
      claims: [claim('added-test')],
      changedFiles: [{ path: 'a.test.ts', status: 'added' }],
      files: { 'a.test.ts': `import { it } from 'vitest';\nit('x', () => {});` },
    });
    expect(f.verdict).toBe('UNVERIFIED');
  });
});

describe('claim-reconciliation · no-public-api-change', () => {
  it('PASS when exports are identical between base and head', () => {
    const f = sole({
      claims: [claim('no-public-api-change')],
      base: 'BASE',
      changedFiles: [{ path: 'src/api.ts' }],
      baseFiles: { 'src/api.ts': `export function b() { return 1; }` },
      files: { 'src/api.ts': `export function b() { return 2; }` },
    });
    expect(f.verdict).toBe('PASS');
  });

  it('CONTRADICTED when head adds a new export', () => {
    const f = sole({
      claims: [claim('no-public-api-change')],
      base: 'BASE',
      changedFiles: [{ path: 'src/api.ts' }],
      baseFiles: { 'src/api.ts': `export function b() {}` },
      files: { 'src/api.ts': `export function b() {}\nexport const c = 3;` },
    });
    expect(f.verdict).toBe('CONTRADICTED');
    expect(f.detail).toContain('+c');
  });

  it('UNVERIFIED when there is no base ref to compare', () => {
    const f = sole({
      claims: [claim('no-public-api-change')],
      changedFiles: [{ path: 'src/api.ts' }],
      files: { 'src/api.ts': `export const a = 1;` },
    });
    expect(f.verdict).toBe('UNVERIFIED');
  });

  it('UNVERIFIED when a changed module re-exports via `export *` (not enumerable)', () => {
    const f = sole({
      claims: [claim('no-public-api-change')],
      base: 'BASE',
      changedFiles: [{ path: 'src/api.ts' }],
      baseFiles: { 'src/api.ts': `export * from './x';` },
      files: { 'src/api.ts': `export * from './x';\nexport const a = 1;` },
    });
    expect(f.verdict).toBe('UNVERIFIED');
  });
});

describe('claim-reconciliation · unknown claims never block', () => {
  it('UNVERIFIED for an unrecognized claim', () => {
    const f = sole({
      claims: [claim('frobnicate-the-widgets')],
      changedFiles: [{ path: 'src/foo.ts' }],
      files: { 'src/foo.ts': `export const x = 1;` },
    });
    expect(f.verdict).toBe('UNVERIFIED');
    expect(f.title).toBe('Unrecognized claim');
  });
});
