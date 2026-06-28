import { describe, it, expect } from 'vitest';
import { commentCodeDrift, __test__ } from '../src/analyzers/commentCodeDrift';
import type { AnalyzerContext, ChangedFile, Finding } from '../src/types';

const { collectDeclarations, changedSymbolNames, findStaleCommentMentions } = __test__;

interface Spec {
  changedFiles: Array<{ path: string; status?: ChangedFile['status']; addedLines?: number[] }>;
  baseFiles: Record<string, string>;
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
    base: 'BASE',
    changedFiles,
    readFile: (p) => spec.files[p] ?? null,
    readBaseFile: (p) => spec.baseFiles[p] ?? null,
  };
}

function run(spec: Spec): Finding[] {
  return commentCodeDrift.run(makeCtx(spec));
}

describe('comment-code-drift · pure helpers', () => {
  it('collectDeclarations finds function/const/type names', () => {
    const decls = collectDeclarations(
      `export function foo() {}\nconst bar = 1;\nexport interface Baz {}\nexport type Q = string;\n`,
      'a.ts',
    );
    const names = decls.map((d) => d.name).sort();
    expect(names).toEqual(['Baz', 'Q', 'bar', 'foo']);
  });

  it('changedSymbolNames flags a body-edited function', () => {
    const base = `export function greet(name) { return 'hi ' + name; }\n`;
    const head = `export function greet(name) { return 'hello ' + name; }\n`;
    const info = changedSymbolNames(base, head, 'a.ts');
    expect(info.names.has('greet')).toBe(true);
  });

  it('changedSymbolNames flags a removed/renamed symbol via its old name', () => {
    const base = `export function oldName() { return 1; }\n`;
    const head = `export function newName() { return 1; }\n`;
    const info = changedSymbolNames(base, head, 'a.ts');
    expect(info.names.has('oldName')).toBe(true);
  });

  it('changedSymbolNames is empty when nothing changed', () => {
    const same = `export function greet() { return 1; }\n`;
    expect(changedSymbolNames(same, same, 'a.ts').names.size).toBe(0);
  });

  it('findStaleCommentMentions matches a symbol token in a comment', () => {
    const mentions = findStaleCommentMentions(
      `// calls greet\nexport const x = 1;\n`,
      'a.ts',
      new Set(['greet']),
      new Set<number>(),
    );
    expect(mentions.length).toBe(1);
    expect(mentions[0].symbol).toBe('greet');
  });

  it('findStaleCommentMentions SKIPS comments on freshly-added lines', () => {
    const mentions = findStaleCommentMentions(
      `// calls greet\nexport const x = 1;\n`,
      'a.ts',
      new Set(['greet']),
      new Set([1]), // line 1 was added in this diff → not stale
    );
    expect(mentions).toHaveLength(0);
  });
});

describe('comment-code-drift · verdict matrix', () => {
  it('UNVERIFIED: body-edited symbol + lingering old comment (same file)', () => {
    // The comment references the symbol by its exact identifier token (`greet`), the realistic drift
    // case for a docstring/tag like `// greet: ...` or `@greet`. (Inflectional variants like "greets"
    // are intentionally NOT matched — that would balloon false positives.)
    // Only line 2 (the changed function body) is "added"; the comment on line 1 is pre-existing.
    const f = run({
      changedFiles: [{ path: 'src/greet.ts', addedLines: [2] }],
      baseFiles: { 'src/greet.ts': `// greet: says hi\nexport function greet() { return 'hi'; }\n` },
      files: { 'src/greet.ts': `// greet: says hi\nexport function greet() { return 'hello'; }\n` },
    });
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f[0].verdict).toBe('UNVERIFIED');
    expect(f[0].detail).toContain("'greet'");
  });

  it('no finding when the only comment was ADDED in the diff (FP cut)', () => {
    const f = run({
      changedFiles: [{ path: 'src/greet.ts', addedLines: [1] }],
      baseFiles: { 'src/greet.ts': `export function greet() { return 'hi'; }\n` },
      files: { 'src/greet.ts': `// calls greet\nexport function greet() { return 'hello'; }\n` },
    });
    // Comment on line 1 was added → not stale. No finding for greet.
    const greetFindings = f.filter((x) => x.detail.includes("'greet'"));
    expect(greetFindings).toHaveLength(0);
  });

  it('UNVERIFIED: cross-file — comment in ANOTHER changed file mentions the edited symbol', () => {
    // greet.ts body changed (added line 2); usage.ts content is unchanged (no added lines) but its
    // pre-existing comment still references greet → cross-file drift signal.
    const f = run({
      changedFiles: [{ path: 'src/greet.ts', addedLines: [2] }, { path: 'src/usage.ts', addedLines: [] }],
      baseFiles: {
        'src/greet.ts': `export function greet() { return 'hi'; }\n`,
        'src/usage.ts': `// TODO: use greet here\nexport const u = 1;\n`,
      },
      files: {
        'src/greet.ts': `export function greet() { return 'hello'; }\n`,
        'src/usage.ts': `// TODO: use greet here\nexport const u = 1;\n`,
      },
    });
    expect(f.some((x) => x.file === 'src/usage.ts' && x.detail.includes("'greet'"))).toBe(true);
  });

  it('no finding when no symbols changed', () => {
    const f = run({
      changedFiles: [{ path: 'src/greet.ts' }],
      baseFiles: { 'src/greet.ts': `// hi\nexport function greet() { return 1; }\n` },
      files: { 'src/greet.ts': `// hi\nexport function greet() { return 1; }\n` },
    });
    expect(f).toHaveLength(0);
  });

  it('ignores test files as a changed-symbol SOURCE (a test referencing a renamed util is fine)', () => {
    const f = run({
      changedFiles: [{ path: 'src/greet.test.ts' }],
      baseFiles: { 'src/greet.test.ts': `// uses greet\nexport function helper() {}\n` },
      files: { 'src/greet.test.ts': `// uses greet\nexport function helper() { return 2; }\n` },
    });
    // helper changed in a test file → not gathered as a source symbol → no finding.
    expect(f).toHaveLength(0);
  });

  it('silences when there is no base ref (cannot compare)', () => {
    const ctx: AnalyzerContext = {
      repoRoot: '/virtual',
      base: undefined,
      readBaseFile: undefined,
      changedFiles: [{ path: 'src/greet.ts', status: 'modified', addedLines: new Set([1]) }],
      readFile: () => `// x\nexport function greet() {}\n`,
    };
    expect(commentCodeDrift.run(ctx)).toHaveLength(0);
  });

  // The load-bearing contract: staleness is semantic → never CONTRADICTED (§3.4). Cannot block.
  it('NEVER emits CONTRADICTED across a battery of drift inputs', () => {
    const battery: Spec[] = [
      {
        changedFiles: [{ path: 'src/auth.ts' }],
        baseFiles: { 'src/auth.ts': `// auth fn\nexport function login() { return 1; }\n` },
        files: { 'src/auth.ts': `// auth fn\nexport function login() { return 2; }\n` },
      },
      {
        changedFiles: [{ path: 'src/util.ts' }, { path: 'src/app.ts' }],
        baseFiles: {
          'src/util.ts': `export function parseToken() { return 1; }\n`,
          'src/app.ts': `// uses parseToken\nexport const app = 1;\n`,
        },
        files: {
          'src/util.ts': `export function parseToken() { return 2; }\n`,
          'src/app.ts': `// uses parseToken\nexport const app = 1;\n`,
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
