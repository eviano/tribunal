import { describe, it, expect } from 'vitest';
import { buildReport, exitCode, renderMarkdown } from '../src/report/render';
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
