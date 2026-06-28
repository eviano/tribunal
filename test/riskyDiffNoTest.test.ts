import { describe, it, expect, afterEach } from 'vitest';
import { riskyDiffNoTest, setSkipGenerated, __test__ } from '../src/analyzers/riskyDiffNoTest';
import { isGeneratedPath } from '../src/paths';
import type { AnalyzerContext, ChangedFile, Finding } from '../src/types';

// `skipGenerated` is module-level mutable; restore the default after each test so ordering can't leak.
afterEach(() => setSkipGenerated(true));

const { tokenize, touchesRiskyVocab, basenameStem, stemsCorrelated } = __test__;

interface Spec {
  changedFiles: Array<{ path: string; status?: ChangedFile['status']; addedLines?: number[] }>;
  files: Record<string, string>;
}

function makeCtx(spec: Spec): AnalyzerContext {
  const changedFiles: ChangedFile[] = spec.changedFiles.map((f) => {
    const content = spec.files[f.path] ?? '';
    const lineCount = content.split('\n').length;
    const added = new Set(f.addedLines ?? Array.from({ length: lineCount }, (_, i) => i + 1));
    return { path: f.path, status: f.status ?? 'modified', addedLines: added };
  });
  return {
    repoRoot: '/virtual',
    changedFiles,
    readFile: (p) => spec.files[p] ?? null,
  };
}

function run(spec: Spec): Finding[] {
  return riskyDiffNoTest.run(makeCtx(spec));
}

describe('risky-diff-no-test · verdict matrix', () => {
  it('UNVERIFIED: risky path changed, no test added', () => {
    const f = run({ changedFiles: [{ path: 'src/auth.ts' }], files: { 'src/auth.ts': `export function login(u, p) { return u === p; }\n` } });
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('UNVERIFIED');
    expect(f[0].title).toContain('Risky change with no correlated test');
    expect(f[0].detail).toContain("'auth'");
  });

  it('PASS: risky path changed AND a correlated asserting test was added', () => {
    const f = run({
      changedFiles: [{ path: 'src/auth.ts', status: 'modified' }, { path: 'src/auth.test.ts', status: 'added' }],
      files: {
        'src/auth.ts': `export function login(u, p) { return u === p; }\n`,
        'src/auth.test.ts': `import { it, expect } from 'vitest';\nimport { login } from './auth';\nit('logs in', () => { expect(login('a', 'a')).toBe(true); });\n`,
      },
    });
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('PASS');
  });

  it('UNVERIFIED: risky path changed, but the only test added is UNCORRELATED', () => {
    const f = run({
      changedFiles: [{ path: 'src/auth.ts', status: 'modified' }, { path: 'src/util.test.ts', status: 'added' }],
      files: {
        'src/auth.ts': `export function login(u, p) { return u === p; }\n`,
        'src/util.test.ts': `import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n`,
      },
    });
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('UNVERIFIED');
  });

  it('no finding: non-risky source changed', () => {
    expect(run({ changedFiles: [{ path: 'src/format.ts' }], files: { 'src/format.ts': `export const fmt = (s) => s.trim();\n` } })).toHaveLength(0);
  });
});

describe('risky-diff-no-test · identifier detection (not just path)', () => {
  it('UNVERIFIED: non-risky path but a changed-line identifier is risky', () => {
    const f = run({
      changedFiles: [{ path: 'src/handlers/request.ts', addedLines: [2] }],
      files: {
        'src/handlers/request.ts': `// line 1 context\nexport function verifyPassword(p) { return p.length > 0; }\n// line 3 context\n`,
      },
    });
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('UNVERIFIED');
    expect(f[0].detail).toContain("'password'");
  });

  it('no finding: risky identifier on an UNCHANGED line is ignored', () => {
    const f = run({
      changedFiles: [{ path: 'src/handlers/request.ts', addedLines: [3] }],
      files: {
        'src/handlers/request.ts': `export function verifyPassword(p) { return p.length > 0; }\n// line 2\nexport const unrelated = 1;\n`,
      },
    });
    expect(f).toHaveLength(0);
  });
});

describe('risky-diff-no-test · precision (token, not substring)', () => {
  it.each([
    ['authors.ts', false], // must NOT match 'auth' — substring-safety
    ['tokenize.ts', false], // must NOT match 'token' — substring-safety
    ['authorize.ts', false], // 'authorize' is a single token, not in vocab — conservative by design
    ['authorization.ts', false], // 'authorization' is a single token, not in vocab — conservative
  ])('path segment %s → touchesRisky %s', (path, expected) => {
    expect(touchesRiskyVocab(path)).toBe(expected);
  });

  it("'user-auth.ts' matches 'auth' (kebab segment)", () => {
    expect(touchesRiskyVocab('src/user-auth.ts')).toBe(true);
  });

  it('camelCase split: verifyPassword → tokens include password', () => {
    expect(tokenize('verifyPassword')).toContain('password');
    expect(tokenize('verifyPassword')).not.toContain('verifypassword');
  });
});

describe('risky-diff-no-test · stem correlation', () => {
  it('auth.ts ↔ auth.test.ts are correlated', () => {
    expect(stemsCorrelated(basenameStem('src/auth.ts'), basenameStem('src/auth.test.ts'))).toBe(true);
  });
  it('auth.ts ↔ util.test.ts are NOT correlated', () => {
    expect(stemsCorrelated(basenameStem('src/auth.ts'), basenameStem('src/util.test.ts'))).toBe(false);
  });
  it('user-auth.ts ↔ user-auth.spec.ts are correlated', () => {
    expect(stemsCorrelated(basenameStem('src/user-auth.ts'), basenameStem('tests/user-auth.spec.ts'))).toBe(true);
  });
});

describe('risky-diff-no-test · scoping & safety', () => {
  it('ignores changed TEST files (only source files are risky candidates)', () => {
    // A test file named auth.test.ts is not itself a "risky source" change.
    expect(run({
      changedFiles: [{ path: 'src/auth.test.ts', status: 'modified' }],
      files: { 'src/auth.test.ts': `import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n` },
    })).toHaveLength(0);
  });

  it('ignores deleted risky files', () => {
    expect(run({
      changedFiles: [{ path: 'src/auth.ts', status: 'deleted' }],
      files: {},
    })).toHaveLength(0);
  });

  it('produces one finding per risky file (dedupes multiple risky identifiers in one file)', () => {
    const f = run({
      changedFiles: [{ path: 'src/auth.ts' }],
      files: { 'src/auth.ts': `export function login() {}\nexport function password() {}\nexport function token() {}\n` },
    });
    expect(f).toHaveLength(1);
  });

  // The load-bearing contract for this analyzer: it must NEVER emit CONTRADICTED, because risk is
  // semantic and §3.4 forbids semantic CONTRADICTED. It cannot cause a false red under --hard-fail.
  it('NEVER emits CONTRADICTED across a battery of risky inputs', () => {
    const battery: Spec[] = [
      { changedFiles: [{ path: 'auth.ts' }], files: { 'auth.ts': `export const x = 1;\n` } },
      { changedFiles: [{ path: 'src/crypto/hash.ts' }], files: { 'src/crypto/hash.ts': `export function h() {}\n` } },
      { changedFiles: [{ path: 'payment/checkout.ts' }], files: { 'payment/checkout.ts': `export function pay() {}\n` } },
      {
        changedFiles: [{ path: 'src/login.ts' }, { path: 'src/login.test.ts', status: 'added' }],
        files: {
          'src/login.ts': `export function login() {}\n`,
          'src/login.test.ts': `import {it,expect} from 'vitest';\nit('w', () => { expect(1).toBe(1); });\n`,
        },
      },
    ];
    for (const spec of battery) {
      for (const f of run(spec)) {
        expect(f.verdict).not.toBe('CONTRADICTED');
      }
    }
  });
});

describe('isGeneratedPath', () => {
  it.each([
    ['action-dist/cli.cjs', true], // the recurring false-ish positive from the dogfood
    ['dist/auth.js', true],
    ['build/auth.js', true],
    ['packages/foo/dist/auth.js', true], // nested generated dir
    ['vendor/lib.min.js', true], // minified bundle
    ['app.bundle.js', true],
    ['src/auth.ts', false], // hand-written source — must NOT be skipped
    ['lib/auth.ts', false], // 'lib' is not a generated dir
    ['auth.ts', false],
    ['README.md', false],
  ])('%s → generated=%s', (path, expected) => {
    expect(isGeneratedPath(path)).toBe(expected);
  });
});

describe('risky-diff-no-test · generated-path skip', () => {
  // The exact case that fired on every PR this session: the bundled artifact carries the project's own
  // `token` vocab. It must be skipped by default (it's not human-authored source a reviewer can act on).
  it('skips action-dist/cli.cjs by default (no finding)', () => {
    const f = run({
      changedFiles: [{ path: 'action-dist/cli.cjs' }],
      files: { 'action-dist/cli.cjs': `function token(){return'x'}\nexport function login(){}\n` },
    });
    expect(f).toHaveLength(0);
  });

  it('skips dist/ and *.min.js paths', () => {
    expect(
      run({ changedFiles: [{ path: 'dist/auth.js' }], files: { 'dist/auth.js': `export const x=1;\n` } }),
    ).toHaveLength(0);
    expect(
      run({ changedFiles: [{ path: 'vendor/lib.min.js' }], files: { 'vendor/lib.min.js': `var token=1;\n` } }),
    ).toHaveLength(0);
  });

  it('still flags hand-written source with the same vocab (does NOT over-suppress)', () => {
    const f = run({
      changedFiles: [{ path: 'src/auth.ts' }],
      files: { 'src/auth.ts': `export function login() {}\n` },
    });
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('UNVERIFIED');
  });

  it('--no-skip-generated (setSkipGenerated(false)) re-enables flagging generated paths', () => {
    setSkipGenerated(false);
    const f = run({
      changedFiles: [{ path: 'action-dist/cli.cjs' }],
      files: { 'action-dist/cli.cjs': `function token(){return'x'}\n` },
    });
    expect(f).toHaveLength(1);
    expect(f[0].verdict).toBe('UNVERIFIED');
    expect(f[0].detail).toContain("'token'");
  });
});
