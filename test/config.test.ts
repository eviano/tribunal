import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYamlSubset } from '../src/config/parseYaml';
import { loadConfig, setKnownAnalyzerIds } from '../src/config/loadConfig';
import { isGeneratedPath } from '../src/paths';

// Register the real analyzer ids so loadConfig validation works in these tests.
setKnownAnalyzerIds([
  'assertion-free-test',
  'hallucinated-symbol',
  'risky-diff-no-test',
  'claim-reconciliation',
]);

describe('parseYamlSubset', () => {
  it('parses scalars: string, boolean, number', () => {
    const o = parseYamlSubset('name: tribunal\nenabled: true\nport: 8080\n');
    expect(o).toEqual({ name: 'tribunal', enabled: true, port: 8080 });
  });

  it('parses an inline list', () => {
    expect(parseYamlSubset('paths: [a, b, "c d"]\n')).toEqual({ paths: ['a', 'b', 'c d'] });
  });

  it('parses a block list', () => {
    const o = parseYamlSubset('generated-paths:\n  - dist/\n  - vendor-gen/\n');
    expect(o).toEqual({ 'generated-paths': ['dist/', 'vendor-gen/'] });
  });

  it('parses a nested map (analyzers)', () => {
    const o = parseYamlSubset('analyzers:\n  risky-diff-no-test: false\n  assertion-free-test: true\n');
    expect(o).toEqual({ analyzers: { 'risky-diff-no-test': false, 'assertion-free-test': true } });
  });

  it('ignores comments and blank lines', () => {
    const o = parseYamlSubset('# header\n\nkey: val  # trailing\n');
    expect(o).toEqual({ key: 'val' });
  });

  it('rejects unexpected indentation', () => {
    expect(() => parseYamlSubset('  stray: 1\n')).toThrow(/unexpected indentation/);
  });

  it('rejects a malformed top-level line', () => {
    expect(() => parseYamlSubset('not a mapping\n')).toThrow();
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trib-config-'));
  });

  it('returns null when no tribunal.yml is present (no-op default)', () => {
    expect(loadConfig(dir)).toBeNull();
  });

  it('loads a full config', () => {
    writeFileSync(
      join(dir, 'tribunal.yml'),
      'analyzers:\n  risky-diff-no-test: false\ngenerated-paths:\n  - vendor-gen/\n  - "**/*.gen.ts"\n',
    );
    const cfg = loadConfig(dir);
    expect(cfg?.analyzers).toEqual({ 'risky-diff-no-test': false });
    expect(cfg?.generatedPaths).toEqual(['vendor-gen/', '**/*.gen.ts']);
  });

  it('rejects an unknown analyzer id (typo guard, fail-loud)', () => {
    writeFileSync(join(dir, 'tribunal.yml'), 'analyzers:\n  risky-dif-no-test: false\n');
    expect(() => loadConfig(dir)).toThrow(/unknown analyzer 'risky-dif-no-test'/);
  });

  it('rejects an unknown top-level key', () => {
    writeFileSync(join(dir, 'tribunal.yml'), 'risky-vocab: [token]\n');
    expect(() => loadConfig(dir)).toThrow(/unknown key 'risky-vocab'/);
  });

  it('rejects a non-boolean analyzer value', () => {
    writeFileSync(join(dir, 'tribunal.yml'), 'analyzers:\n  risky-diff-no-test: maybe\n');
    expect(() => loadConfig(dir)).toThrow(/must be true\|false/);
  });

  it('honors an explicit --config path', () => {
    const custom = join(dir, 'custom.yml');
    writeFileSync(custom, 'generated-paths:\n  - out/\n');
    const cfg = loadConfig(dir, custom);
    expect(cfg?.generatedPaths).toEqual(['out/']);
  });
});

describe('isGeneratedPath with config extras', () => {
  it('still matches the built-ins when extras are empty', () => {
    expect(isGeneratedPath('dist/auth.js')).toBe(true);
    expect(isGeneratedPath('action-dist/cli.cjs')).toBe(true);
    expect(isGeneratedPath('src/auth.ts')).toBe(false);
  });

  it('matches an extra dir-prefix', () => {
    expect(isGeneratedPath('vendor-gen/auth.js', ['vendor-gen/'])).toBe(true);
    expect(isGeneratedPath('src/auth.ts', ['vendor-gen/'])).toBe(false);
  });

  it('matches an extra suffix', () => {
    expect(isGeneratedPath('src/auth.gen.ts', ['.gen.ts'])).toBe(true);
  });

  it('matches a glob extra (** across segments)', () => {
    expect(isGeneratedPath('pkg/sub/auth.gen.ts', ['**/*.gen.ts'])).toBe(true);
    expect(isGeneratedPath('src/auth.ts', ['**/*.gen.ts'])).toBe(false);
  });

  it('extends, never replaces: built-ins still match alongside extras', () => {
    // A user who only configured an extra must not lose the dist/ safety net.
    const extras = ['vendor-gen/'];
    expect(isGeneratedPath('dist/auth.js', extras)).toBe(true); // built-in still works
    expect(isGeneratedPath('vendor-gen/x.js', extras)).toBe(true); // extra works
  });
});
