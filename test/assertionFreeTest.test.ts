import { describe, it, expect } from 'vitest';
import { assertionFreeTest } from '../src/analyzers/assertionFreeTest';
import type { AnalyzerContext, ChangedFile, Finding } from '../src/types';

function ctxFromSource(path: string, content: string, addedLines?: number[]): AnalyzerContext {
  const lineCount = content.split('\n').length;
  const added = new Set(addedLines ?? Array.from({ length: lineCount }, (_, i) => i + 1));
  const file: ChangedFile = { path, status: 'modified', addedLines: added };
  return {
    repoRoot: '/virtual',
    changedFiles: [file],
    readFile: (p) => (p === path ? content : null),
  };
}

function run(path: string, content: string, addedLines?: number[]): Finding[] {
  return assertionFreeTest.run(ctxFromSource(path, content, addedLines));
}

function soleVerdict(path: string, content: string, addedLines?: number[]): string {
  const findings = run(path, content, addedLines);
  expect(findings.length).toBe(1);
  return findings[0].verdict;
}

describe('assertion-free-test · PASS (assertion is reachable)', () => {
  it('expect(...) from vitest', () => {
    const src = `import { it, expect } from 'vitest';
it('adds', () => {
  expect(1 + 1).toBe(2);
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('PASS');
  });

  it('assert.equal from node:assert (default import)', () => {
    const src = `import { it } from 'vitest';
import assert from 'node:assert';
it('adds', () => {
  assert.equal(1 + 1, 2);
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('PASS');
  });

  it('named import strictEqual from node:assert', () => {
    const src = `import { test } from 'node:test';
import { strictEqual } from 'node:assert';
test('adds', () => {
  strictEqual(2, 2);
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('PASS');
  });

  it('chai .should style', () => {
    const src = `import { it } from 'vitest';
import { should } from 'chai';
should();
it('should work', () => {
  const result = compute();
  result.should.equal(2);
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('PASS');
  });

  it('assertion via a resolvable local helper', () => {
    const src = `import { it, expect } from 'vitest';
function checkPositive(n) {
  expect(n).toBeGreaterThan(0);
}
it('is positive', () => {
  checkPositive(compute());
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('PASS');
  });

  it('AVA-style context assertion t.is', () => {
    const src = `import test from 'ava';
test('adds', (t) => {
  t.is(1 + 1, 2);
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('PASS');
  });
});

describe('assertion-free-test · CONTRADICTED (syntactic certainty of no assertion)', () => {
  it('empty test body', () => {
    const src = `import { it } from 'vitest';
it('todo later', () => {});`;
    expect(soleVerdict('math.test.ts', src)).toBe('CONTRADICTED');
  });

  it('only assignments, no calls at all', () => {
    const src = `import { it } from 'vitest';
it('computes', () => {
  const x = 1 + 1;
  const y = x * 2;
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('CONTRADICTED');
  });

  it('only a local helper that cannot assert', () => {
    const src = `import { it } from 'vitest';
function setup() {
  const config = { a: 1 };
  return config;
}
it('sets up', () => {
  setup();
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('CONTRADICTED');
  });
});

describe('assertion-free-test · UNVERIFIED (cannot decide — never block)', () => {
  it('calls an external helper that might assert', () => {
    const src = `import { it } from 'vitest';
import { checkInvariant } from './helpers';
it('verifies invariant', () => {
  const r = compute(2);
  checkInvariant(r);
});`;
    expect(soleVerdict('math.test.ts', src)).toBe('UNVERIFIED');
  });
});

describe('assertion-free-test · scoping', () => {
  it('ignores tests not touched by the diff', () => {
    const src = `import { it } from 'vitest';
it('empty', () => {});`;
    // Only line 1 (the import) is in the diff; the test on line 2 is untouched.
    expect(run('math.test.ts', src, [1])).toHaveLength(0);
  });

  it('ignores skipped tests', () => {
    const src = `import { it } from 'vitest';
it.skip('later', () => {});`;
    expect(run('math.test.ts', src)).toHaveLength(0);
  });

  it('ignores non-test files', () => {
    const src = `export function add(a, b) { return a + b; }`;
    expect(run('src/math.ts', src)).toHaveLength(0);
  });

  it('flags each bad test independently in a multi-test file', () => {
    const src = `import { it, expect } from 'vitest';
it('good', () => {
  expect(add(1, 2)).toBe(3);
});
it('bad', () => {
  const r = 1 + 2;
});`;
    const findings = run('math.test.ts', src);
    expect(findings).toHaveLength(2);
    const byVerdict = findings.map((f) => f.verdict).sort();
    expect(byVerdict).toEqual(['CONTRADICTED', 'PASS']);
  });
});
