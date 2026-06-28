import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hallucinatedSymbol } from '../src/analyzers/hallucinatedSymbol';
import type { AnalyzerContext, ChangedFile, Finding } from '../src/types';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tribunal-m1-'));
  // A module with a couple of real exports, including an aliased one.
  writeFileSync(
    join(tmp, 'lib.ts'),
    `export const foo = 1;
export function bar() {}
const internal = 2;
export { internal as aliased };
`,
  );
  // A clean re-export of lib (resolvable `export *`).
  writeFileSync(join(tmp, 'reexport.ts'), `export * from './lib';\n`);
  // A re-export from an unresolvable package — exports cannot be enumerated.
  writeFileSync(join(tmp, 'starUncertain.ts'), `export * from 'totally-missing-pkg';\n`);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function analyze(consumerRel: string, content: string, addedLines?: number[]): Finding[] {
  writeFileSync(join(tmp, consumerRel), content);
  const lineCount = content.split('\n').length;
  const added = new Set(addedLines ?? Array.from({ length: lineCount }, (_, i) => i + 1));
  const file: ChangedFile = { path: consumerRel, status: 'added', addedLines: added };
  const ctx: AnalyzerContext = {
    repoRoot: tmp,
    changedFiles: [file],
    readFile: (p) => {
      try {
        return readFileSync(join(tmp, p), 'utf8');
      } catch {
        return null;
      }
    },
  };
  return hallucinatedSymbol.run(ctx);
}

function sole(consumerRel: string, content: string, addedLines?: number[]): Finding {
  const findings = analyze(consumerRel, content, addedLines);
  expect(findings).toHaveLength(1);
  return findings[0];
}

describe('hallucinated-symbol · no finding (valid imports)', () => {
  it('valid named import', () => {
    expect(analyze('c-ok.ts', `import { foo } from './lib';\nconsole.log(foo);`)).toHaveLength(0);
  });

  it('valid aliased export', () => {
    expect(analyze('c-alias.ts', `import { aliased } from './lib';\nconsole.log(aliased);`)).toHaveLength(0);
  });

  it('name reachable through a resolvable `export *`', () => {
    expect(analyze('c-reexp.ts', `import { foo } from './reexport';\nconsole.log(foo);`)).toHaveLength(0);
  });

  it('default import is never flagged (interop)', () => {
    expect(analyze('c-default.ts', `import whatever from './lib';\nconsole.log(whatever);`)).toHaveLength(0);
  });
});

describe('hallucinated-symbol · CONTRADICTED (syntactic certainty)', () => {
  it('named export that does not exist on a resolved local module', () => {
    const f = sole('c-nope.ts', `import { parseConifg } from './lib';`);
    expect(f.verdict).toBe('CONTRADICTED');
    expect(f.title).toBe('Import of nonexistent export');
  });

  it('relative import path that resolves to no file', () => {
    const f = sole('c-missing.ts', `import { x } from './does-not-exist';`);
    expect(f.verdict).toBe('CONTRADICTED');
    expect(f.title).toBe('Import path does not exist');
  });
});

describe('hallucinated-symbol · UNVERIFIED (cannot decide — never block)', () => {
  it('unresolved bare package import (deferred to dependency checking)', () => {
    const f = sole('c-pkg.ts', `import { z } from 'totally-missing-pkg';`);
    expect(f.verdict).toBe('UNVERIFIED');
    expect(f.title).toBe('Unresolved package import');
  });

  it('named import through an unresolvable `export *` cannot be confirmed', () => {
    const f = sole('c-uncertain.ts', `import { ghost } from './starUncertain';`);
    expect(f.verdict).toBe('UNVERIFIED');
    expect(f.title).toBe('Unverifiable named import');
  });
});

describe('hallucinated-symbol · scoping', () => {
  it('ignores imports not touched by the diff', () => {
    // The bad import is on line 1; only line 2 is in the diff.
    expect(analyze('c-untouched.ts', `import { nope } from './lib';\nconst y = 1;`, [2])).toHaveLength(0);
  });
});

describe('hallucinated-symbol · Node.js built-ins are never flagged', () => {
  // Built-ins are environment-provided and always resolvable at runtime; flagging them is pure noise
  // (it fires whenever the repo has no node_modules on the runner). They produce NO finding.
  it.each([
    'node:fs',
    'node:crypto',
    'node:path',
    'node:child_process',
    'node:os',
    'fs', // legacy bare form
    'path',
    'crypto',
  ])('no finding for import from %s', (spec) => {
    expect(analyze(`c-${spec.replace(/[^a-z]/gi, '')}.ts`, `import { x } from '${spec}';`)).toHaveLength(0);
  });

  it('a non-builtin package is STILL flagged UNVERIFIED when unresolved', () => {
    const f = sole('c-stillpkg.ts', `import { z } from 'totally-missing-pkg';`);
    expect(f.verdict).toBe('UNVERIFIED');
    expect(f.title).toBe('Unresolved package import');
  });
});
