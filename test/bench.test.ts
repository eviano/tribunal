import { describe, it, expect } from 'vitest';
import { cases } from '../bench/cases';
import { runCase, summarize, TARGETS } from '../bench/harness';

describe('benchmark seed corpus', () => {
  const results = cases.map(runCase);
  const summary = summarize(results);

  it('never produces a false CONTRADICTED on clean cases (the hard guarantee)', () => {
    const falsePositives = results.filter((r) => r.outcome === 'FP');
    expect(falsePositives.map((r) => r.id)).toEqual([]);
    expect(summary.falsePositiveRate).toBeLessThanOrEqual(TARGETS.maxFalsePositiveRate);
  });

  it('catches every seeded defect', () => {
    const misses = results.filter((r) => r.outcome === 'FN');
    expect(misses.map((r) => r.id)).toEqual([]);
    expect(summary.recall).toBeGreaterThanOrEqual(TARGETS.minRecall);
  });

  it('each case lands on its expected side', () => {
    for (const r of results) {
      if (r.label === 'defect') expect(r.flagged, `${r.id} should be flagged`).toBe(true);
      else expect(r.flagged, `${r.id} should be clean`).toBe(false);
    }
  });
});
