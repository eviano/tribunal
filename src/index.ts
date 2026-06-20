/**
 * Tribunal — public API.
 *
 * A deterministic, no-LLM-in-the-verification-path gate for agent-authored PRs. See docs/SPEC.md.
 */
import { analyzers as defaultAnalyzers } from './analyzers/index.js';
import { makeContext, type DiffSource } from './diff/gitDiff.js';
import { buildReport } from './report/render.js';
import type { Analyzer, AnalyzerContext, Report } from './types.js';

export type { Analyzer, AnalyzerContext, ChangedFile, Claim, Finding, Report, Verdict } from './types.js';
export { analyzers, assertionFreeTest, hallucinatedSymbol, claimReconciliation } from './analyzers/index.js';
export { recognizedClaims } from './analyzers/claimReconciliation.js';
export { parseClaims, type ParseClaimsOptions } from './claims.js';
export { parseUnifiedDiff } from './diff/parseUnifiedDiff.js';
export { getChangedFiles, makeContext, type DiffSource } from './diff/gitDiff.js';
export { buildReport, exitCode, renderJson, renderMarkdown } from './report/render.js';

export interface RunOptions {
  analyzers?: Analyzer[];
}

/** Run analyzers over an AnalyzerContext and aggregate into a Report. */
export function runAnalyzers(ctx: AnalyzerContext, opts: RunOptions = {}): Report {
  const list = opts.analyzers ?? defaultAnalyzers;
  const findings = list.flatMap((a) => a.run(ctx));
  return buildReport(findings, list.length);
}

/** Convenience: build a context from a DiffSource and run the analyzers. */
export function runTribunal(src: DiffSource, opts: RunOptions = {}): Report {
  return runAnalyzers(makeContext(src), opts);
}
