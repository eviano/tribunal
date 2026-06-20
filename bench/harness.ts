import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAnalyzers } from '../src/index.js';
import { parseClaims } from '../src/claims.js';
import type { AnalyzerContext, ChangedFile, Finding } from '../src/types.js';

/**
 * A labeled benchmark case.
 *  - `defect` : Tribunal SHOULD catch it — we expect at least one CONTRADICTED finding.
 *  - `clean`  : Tribunal must NOT emit any CONTRADICTED finding (the false-positive guard).
 *
 * The metric that matters most is the false-CONTRADICTED rate on `clean` cases: per the Trust Contract,
 * a single false red is worse than a missed defect. This harness fails CI if that rate is above target.
 */
export type Label = 'defect' | 'clean';

export interface BenchCase {
  id: string;
  label: Label;
  description: string;
  /** The head (post-change) tree, written to a temp dir so on-disk module resolution works. */
  files: Record<string, string>;
  /** The base (pre-change) tree, injected for `no-public-api-change` style checks. */
  baseFiles?: Record<string, string>;
  /** Which files the "diff" touched. addedLines defaults to every line of the file. */
  changed: Array<{ path: string; status?: ChangedFile['status']; addedLines?: number[] }>;
  /** Machine-readable claim lines (as they'd appear in a tribunal block). */
  claims?: string[];
  /** Set to enable base-tree reads (any truthy ref name). */
  base?: string;
}

export type Outcome = 'TP' | 'FP' | 'TN' | 'FN';

export interface CaseResult {
  id: string;
  label: Label;
  description: string;
  findings: Finding[];
  contradicted: number;
  unverified: number;
  pass: number;
  flagged: boolean;
  outcome: Outcome;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

export function runCase(c: BenchCase): CaseResult {
  const dir = mkdtempSync(join(tmpdir(), 'tribunal-bench-'));
  try {
    for (const [rel, content] of Object.entries(c.files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }

    const changedFiles: ChangedFile[] = c.changed.map((f) => {
      const content = c.files[f.path] ?? '';
      const addedLines = new Set(f.addedLines ?? range(content.split('\n').length));
      return { path: f.path, status: f.status ?? 'modified', addedLines };
    });

    const ctx: AnalyzerContext = {
      repoRoot: dir,
      base: c.base,
      claims: c.claims?.length ? parseClaims(c.claims.join('\n')) : undefined,
      changedFiles,
      readFile: (p) => {
        try {
          return readFileSync(join(dir, p), 'utf8');
        } catch {
          return null;
        }
      },
      readBaseFile: c.baseFiles ? (p) => c.baseFiles![p] ?? null : undefined,
    };

    const report = runAnalyzers(ctx);
    const flagged = report.counts.CONTRADICTED > 0;
    const outcome: Outcome =
      c.label === 'defect' ? (flagged ? 'TP' : 'FN') : flagged ? 'FP' : 'TN';

    return {
      id: c.id,
      label: c.label,
      description: c.description,
      findings: report.findings,
      contradicted: report.counts.CONTRADICTED,
      unverified: report.counts.UNVERIFIED,
      pass: report.counts.PASS,
      flagged,
      outcome,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface BenchSummary {
  total: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** Of defect cases, the fraction caught. */
  recall: number;
  /** Of clean cases, the fraction wrongly flagged. MUST be ~0. */
  falsePositiveRate: number;
  /** Of all flagged cases, the fraction that were real defects. */
  precision: number;
}

export function summarize(results: CaseResult[]): BenchSummary {
  const tp = results.filter((r) => r.outcome === 'TP').length;
  const fp = results.filter((r) => r.outcome === 'FP').length;
  const tn = results.filter((r) => r.outcome === 'TN').length;
  const fn = results.filter((r) => r.outcome === 'FN').length;
  return {
    total: results.length,
    tp,
    fp,
    tn,
    fn,
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    falsePositiveRate: fp + tn === 0 ? 0 : fp / (fp + tn),
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
  };
}

/** Targets from docs/SPEC.md §7. The false-positive target is the hard one. */
export const TARGETS = {
  maxFalsePositiveRate: 0.02,
  minRecall: 0.9,
};
