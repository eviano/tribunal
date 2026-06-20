import type { BenchCase } from './harness.js';

/**
 * Curated seed corpus. Each case is a small, self-contained "agent PR". The corpus is intentionally
 * adversarial on the clean side: it includes risky-looking-but-correct changes (big refactors with a
 * no-API-change claim, tests that call helpers without a literal assert) that a naive checker would
 * false-flag. The real MSR'26 PR-MCI labeled set plugs in alongside these (see bench/README.md).
 */
export const cases: BenchCase[] = [
  // ───────────────────────── defects (expect ≥1 CONTRADICTED) ─────────────────────────
  {
    id: 'D1-empty-test',
    label: 'defect',
    description: 'Agent "added a test" that is an empty stub.',
    files: { 'empty.test.ts': `import { it } from 'vitest';\nit('todo', () => {});\n` },
    changed: [{ path: 'empty.test.ts', status: 'added' }],
  },
  {
    id: 'D2-no-call-test',
    label: 'defect',
    description: 'Test with only assignments — nothing that could assert.',
    files: {
      'calc.test.ts': `import { it } from 'vitest';\nit('calc', () => {\n  const x = 1 + 1;\n  const y = x * 2;\n});\n`,
    },
    changed: [{ path: 'calc.test.ts', status: 'added' }],
  },
  {
    id: 'D3-nonasserting-helper',
    label: 'defect',
    description: 'Test that only calls a local helper which cannot assert.',
    files: {
      'setup.test.ts': `import { it } from 'vitest';\nfunction setup() { const c = { a: 1 }; return c; }\nit('setup', () => { setup(); });\n`,
    },
    changed: [{ path: 'setup.test.ts', status: 'added' }],
  },
  {
    id: 'D4-hallucinated-export',
    label: 'defect',
    description: 'Imports a named export that does not exist on a local module.',
    files: {
      'lib.ts': `export const foo = 1;\n`,
      'bad.ts': `import { nope } from './lib';\nexport const b = 1;\n`,
    },
    changed: [{ path: 'bad.ts', status: 'added' }],
  },
  {
    id: 'D5-hallucinated-path',
    label: 'defect',
    description: 'Imports from a relative path that resolves to no file.',
    files: { 'bad2.ts': `import { x } from './missing';\nexport const b = 1;\n` },
    changed: [{ path: 'bad2.ts', status: 'added' }],
  },
  {
    id: 'D6-claim-added-test-but-none',
    label: 'defect',
    description: 'Claims "added-test" but the diff adds no test at all.',
    files: { 'src/widget.ts': `export const widget = 1;\n` },
    changed: [{ path: 'src/widget.ts' }],
    claims: ['added-test'],
  },
  {
    id: 'D7-claim-api-add',
    label: 'defect',
    description: 'Claims "no-public-api-change" but head adds an export.',
    files: { 'src/api.ts': `export function b() {}\nexport const c = 3;\n` },
    baseFiles: { 'src/api.ts': `export function b() {}\n` },
    base: 'BASE',
    changed: [{ path: 'src/api.ts' }],
    claims: ['no-public-api-change'],
  },
  {
    id: 'D8-claim-api-remove',
    label: 'defect',
    description: 'Claims "no-public-api-change" but head removes an export.',
    files: { 'src/api.ts': `export function b() {}\n` },
    baseFiles: { 'src/api.ts': `export function b() {}\nexport const c = 3;\n` },
    base: 'BASE',
    changed: [{ path: 'src/api.ts' }],
    claims: ['no-public-api-change'],
  },
  {
    id: 'D9-combined',
    label: 'defect',
    description: 'A PR with both a hallucinated import and an assertion-free test.',
    files: {
      'lib.ts': `export const real = 1;\n`,
      'feature.ts': `import { fake } from './lib';\nexport const f = 1;\n`,
      'feature.test.ts': `import { it } from 'vitest';\nit('todo', () => {});\n`,
    },
    changed: [
      { path: 'feature.ts', status: 'added' },
      { path: 'feature.test.ts', status: 'added' },
    ],
  },

  {
    id: 'D10-default-flip',
    label: 'defect',
    description: 'Claims "no-default-flip" but silently changes a default timeout.',
    files: { 'src/net.ts': `export function connect(timeoutMs = 5000) { return timeoutMs; }\n` },
    baseFiles: { 'src/net.ts': `export function connect(timeoutMs = 30) { return timeoutMs; }\n` },
    base: 'BASE',
    changed: [{ path: 'src/net.ts' }],
    claims: ['no-default-flip'],
  },

  // ───────────────────────── clean (must NOT emit CONTRADICTED) ─────────────────────────
  {
    id: 'C1-expect-test',
    label: 'clean',
    description: 'A normal test with an assertion.',
    files: {
      'sum.test.ts': `import { it, expect } from 'vitest';\nit('sums', () => { expect(1 + 2).toBe(3); });\n`,
    },
    changed: [{ path: 'sum.test.ts', status: 'added' }],
  },
  {
    id: 'C2-node-assert',
    label: 'clean',
    description: 'A test using node:assert.',
    files: {
      'eq.test.ts': `import test from 'node:test';\nimport assert from 'node:assert';\ntest('eq', () => { assert.equal(1 + 1, 2); });\n`,
    },
    changed: [{ path: 'eq.test.ts', status: 'added' }],
  },
  {
    id: 'C3-helper-asserts',
    label: 'clean',
    description: 'A test that asserts via a resolvable local helper.',
    files: {
      'pos.test.ts': `import { it, expect } from 'vitest';\nfunction checkPositive(n: number) { expect(n).toBeGreaterThan(0); }\nit('pos', () => { checkPositive(5); });\n`,
    },
    changed: [{ path: 'pos.test.ts', status: 'added' }],
  },
  {
    id: 'C4-valid-import',
    label: 'clean',
    description: 'A valid named import from a local module.',
    files: {
      'lib.ts': `export const foo = 1;\n`,
      'consumer.ts': `import { foo } from './lib';\nexport const c = foo;\n`,
    },
    changed: [{ path: 'consumer.ts', status: 'added' }],
  },
  {
    id: 'C5-refactor-no-api-change',
    label: 'clean',
    description: 'A big body refactor with a "no-public-api-change" claim — exports unchanged.',
    files: {
      'src/util.ts': `export function area(r: number) {\n  const pi = 3.14159;\n  return pi * r * r;\n}\n`,
    },
    baseFiles: { 'src/util.ts': `export function area(radius: number) {\n  return 3.14159 * radius * radius;\n}\n` },
    base: 'BASE',
    changed: [{ path: 'src/util.ts' }],
    claims: ['no-public-api-change'],
  },
  {
    id: 'C6-helper-via-import',
    label: 'clean',
    description: 'A test that asserts through an IMPORTED helper — must be UNVERIFIED, not CONTRADICTED.',
    files: {
      'helpers.ts': `import { expect } from 'vitest';\nexport function checkInvariant(x: unknown) { expect(x).toBeTruthy(); }\n`,
      'inv.test.ts': `import { it } from 'vitest';\nimport { checkInvariant } from './helpers';\nit('holds', () => {\n  const r = compute();\n  checkInvariant(r);\n});\n`,
    },
    changed: [{ path: 'inv.test.ts', status: 'added' }],
  },
  {
    id: 'C7-claim-added-test-real',
    label: 'clean',
    description: 'Claims "added-test" and actually adds an asserting test.',
    files: {
      'feature.test.ts': `import { it, expect } from 'vitest';\nit('works', () => { expect(2 + 2).toBe(4); });\n`,
    },
    changed: [{ path: 'feature.test.ts', status: 'added' }],
    claims: ['added-test'],
  },
  {
    id: 'C8-default-unchanged',
    label: 'clean',
    description: 'Claims "no-default-flip"; the body changed but the default did not.',
    files: { 'src/net.ts': `export function connect(timeoutMs = 30) { return timeoutMs + 1; }\n` },
    baseFiles: { 'src/net.ts': `export function connect(timeoutMs = 30) { return timeoutMs; }\n` },
    base: 'BASE',
    changed: [{ path: 'src/net.ts' }],
    claims: ['no-default-flip'],
  },
];
