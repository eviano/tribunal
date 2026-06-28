import { describe, it, expect } from 'vitest';
import { buildReport, exitCode, renderMarkdown, renderSarif } from '../src/report/render';
import type { Finding } from '../src/types';

const contradicted: Finding = {
  analyzer: 'assertion-free-test',
  verdict: 'CONTRADICTED',
  file: 'a.test.ts',
  line: 3,
  title: 'Test asserts nothing',
  detail: 'never fails',
};
const unverified: Finding = {
  analyzer: 'assertion-free-test',
  verdict: 'UNVERIFIED',
  file: 'b.test.ts',
  line: 5,
  title: 'No assertion found',
  detail: 'maybe via helper',
};

describe('exitCode — the fails-safe gate', () => {
  it('blocks only when --hard-fail AND a CONTRADICTED exists', () => {
    const report = buildReport([contradicted], 1);
    expect(exitCode(report, true)).toBe(1);
  });

  it('does not block on CONTRADICTED without --hard-fail (report-only default)', () => {
    const report = buildReport([contradicted], 1);
    expect(exitCode(report, false)).toBe(0);
  });

  it('never blocks on UNVERIFIED, even with --hard-fail', () => {
    const report = buildReport([unverified], 1);
    expect(exitCode(report, true)).toBe(0);
  });

  it('passes cleanly when there are no findings', () => {
    const report = buildReport([], 1);
    expect(exitCode(report, true)).toBe(0);
  });
});

describe('buildReport counts', () => {
  it('tallies verdicts', () => {
    const report = buildReport([contradicted, unverified, unverified], 1);
    expect(report.counts).toEqual({ PASS: 0, UNVERIFIED: 2, CONTRADICTED: 1 });
  });
});

describe('renderMarkdown', () => {
  it('marks report-only when contradictions exist but hard-fail is off', () => {
    const md = renderMarkdown(buildReport([contradicted], 1), false);
    expect(md).toContain('Result: pass (report-only)');
    expect(md).toContain('No LLM is in the verification path.');
  });

  it('marks FAIL when hard-fail is on and a contradiction exists', () => {
    const md = renderMarkdown(buildReport([contradicted], 1), true);
    expect(md).toContain('Result: FAIL');
  });
});

const pass: Finding = {
  analyzer: 'claim-reconciliation',
  verdict: 'PASS',
  file: 'a.test.ts',
  line: 3,
  title: 'Claim confirmed',
  detail: 'ok',
};

describe('renderSarif', () => {
  it('produces a valid SARIF 2.1.0 log with the tribunal tool driver', () => {
    const log = JSON.parse(renderSarif(buildReport([contradicted], 1)));
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif');
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.name).toBe('tribunal');
    expect(log.runs[0].tool.driver.informationUri).toBe('https://github.com/eviano/tribunal');
  });

  it('maps verdicts to levels: CONTRADICTED→error, UNVERIFIED→note, PASS→omitted', () => {
    const report = buildReport([contradicted, unverified, pass], 1);
    const log = JSON.parse(renderSarif(report));
    const levels = log.runs[0].results.map((r: { level: string }) => r.level).sort();
    // PASS finding is omitted; only CONTRADICTED + UNVERIFIED remain.
    expect(levels).toEqual(['error', 'note']);
    expect(log.runs[0].results).toHaveLength(2);
  });

  it('populates ruleId, location uri, and line region', () => {
    const report = buildReport([contradicted], 1);
    const log = JSON.parse(renderSarif(report));
    const r = log.runs[0].results[0];
    expect(r.ruleId).toBe('assertion-free-test');
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe('a.test.ts');
    expect(r.locations[0].physicalLocation.region.startLine).toBe(3);
    expect(r.message.text).toContain('Test asserts nothing');
  });

  it('emits a range region when endLine differs from line', () => {
    const ranged: Finding = { ...contradicted, line: 3, endLine: 7 };
    const log = JSON.parse(renderSarif(buildReport([ranged], 1)));
    const region = log.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(3);
    expect(region.endLine).toBe(7);
  });

  it('has stable partialFingerprints so GitHub can track an alert across runs', () => {
    // Two identical reports → identical fingerprints (rewording title/detail does NOT change identity).
    const report1 = buildReport([contradicted], 1);
    const report2 = buildReport([{ ...contradicted, title: 'Reworded title', detail: 'new prose' }], 1);
    const fp1 = JSON.parse(renderSarif(report1)).runs[0].results[0].partialFingerprints.tribunal;
    const fp2 = JSON.parse(renderSarif(report2)).runs[0].results[0].partialFingerprints.tribunal;
    expect(fp1).toEqual(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives each analyzer its own rule entry (so GitHub groups alerts by analyzer)', () => {
    const other: Finding = { ...unverified, analyzer: 'hallucinated-symbol', file: 'c.ts' };
    const log = JSON.parse(renderSarif(buildReport([contradicted, other], 1)));
    const ruleIds = log.runs[0].tool.driver.rules.map((r: { id: string }) => r.id).sort();
    expect(ruleIds).toEqual(['assertion-free-test', 'hallucinated-symbol']);
  });

  it('omits rules and results cleanly when there are no non-PASS findings', () => {
    const log = JSON.parse(renderSarif(buildReport([pass], 1)));
    expect(log.runs[0].results).toEqual([]);
    expect(log.runs[0].tool.driver.rules).toEqual([]);
  });
});
