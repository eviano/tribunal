/**
 * Core types for Tribunal.
 *
 * The whole tool is organized around one vocabulary: every check yields one of three verdicts, and
 * the build is gated ONLY on CONTRADICTED. See docs/SPEC.md §3 (the Trust Contract).
 */

/**
 * - `PASS`         — the check was evaluated and the code is consistent with it.
 * - `UNVERIFIED`   — the check could not be decided deterministically. Loud, but NEVER blocks.
 * - `CONTRADICTED` — a syntactic certainty that the code violates the check. The only blocking verdict.
 */
export type Verdict = 'PASS' | 'UNVERIFIED' | 'CONTRADICTED';

export interface Finding {
  /** Analyzer id, e.g. `assertion-free-test`. */
  analyzer: string;
  verdict: Verdict;
  /** Repo-relative path of the file the finding is about. */
  file: string;
  /** 1-based line of the relevant node. */
  line: number;
  /** 1-based end line, when the finding spans a range (e.g. a whole test block). */
  endLine?: number;
  /** Short headline, e.g. "Test asserts nothing". */
  title: string;
  /** Human explanation + evidence for why this verdict was reached. */
  detail: string;
  /** For claim-reconciliation analyzers: the agent claim being checked. */
  claim?: string;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  /** Repo-relative path in the new tree. */
  path: string;
  status: ChangeStatus;
  /** 1-based line numbers in the NEW file that the diff added or modified. */
  addedLines: Set<number>;
}

export interface AnalyzerContext {
  repoRoot: string;
  changedFiles: ChangedFile[];
  /** Read the current (new-tree) content of a repo-relative path, or null if unavailable. */
  readFile(path: string): string | null;
}

export interface Analyzer {
  id: string;
  title: string;
  description: string;
  kind: 'claim-independent' | 'claim-reconciliation';
  run(ctx: AnalyzerContext): Finding[];
}

export interface Report {
  findings: Finding[];
  counts: Record<Verdict, number>;
  /** Number of analyzers that executed. */
  analyzersRun: number;
}
