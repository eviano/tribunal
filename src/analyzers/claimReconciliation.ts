import type { Analyzer, AnalyzerContext, Claim, Finding, Verdict } from '../types.js';
import { assertionFreeTest } from './assertionFreeTest.js';
import { directExports, type DirectExports } from './exports.js';
import { collectDefaultParams, keyMatchesArg } from './defaults.js';

/**
 * `claim-reconciliation` — verifies machine-readable PR claims against what the diff actually did, with
 * deterministic checks only. This is the durable-moat milestone (docs/SPEC.md §5b): the company selling
 * you the agent won't ship the tool that catches its own agent lying.
 *
 * Trust Contract: gate only on CONTRADICTED, and CONTRADICTED must be a syntactic certainty. An unknown
 * claim, a missing base ref, or an un-enumerable module all degrade to UNVERIFIED — never a false red.
 */

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_RE = /(^|[./\\])(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_RE = /(^|[/\\])(__tests__|tests?)[/\\]/i;

function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path) || TEST_DIR_RE.test(path);
}

interface VerifierResult {
  verdict: Verdict;
  title: string;
  detail: string;
}
type Verifier = (ctx: AnalyzerContext, claim: Claim) => VerifierResult;

/** "added a test" → the diff must add at least one test, ideally one with a detectable assertion. */
function verifyAddedTest(ctx: AnalyzerContext): VerifierResult {
  // Reuse the assertion-free-test analyzer: it emits one finding per test touched by the diff.
  const testFindings = assertionFreeTest.run(ctx);
  const touched = testFindings.length;
  const asserting = testFindings.filter((f) => f.verdict === 'PASS').length;

  if (asserting > 0) {
    return {
      verdict: 'PASS',
      title: 'Claim confirmed: test added',
      detail: `The diff adds ${asserting} test(s) with at least one assertion.`,
    };
  }
  if (touched === 0) {
    return {
      verdict: 'CONTRADICTED',
      title: "Claimed a test was added, but none is in the diff",
      detail: 'No new test (no it()/test()/Deno.test() block) appears in any changed test file.',
    };
  }
  return {
    verdict: 'UNVERIFIED',
    title: 'Test added, but its assertion could not be detected',
    detail: `The diff adds ${touched} test(s), but none has a detectable assertion (see the assertion-free-test findings). Confirm the test is meaningful.`,
  };
}

const EMPTY_EXPORTS: DirectExports = { names: new Set(), hasDefault: false, uncertain: false };

/** "no public API change" → exported-symbol set is identical between base and head for changed files. */
function verifyNoPublicApiChange(ctx: AnalyzerContext): VerifierResult {
  if (!ctx.base || !ctx.readBaseFile) {
    return {
      verdict: 'UNVERIFIED',
      title: 'No base ref to compare the public API',
      detail: 'Exported-symbol changes need a base ref to diff against; none was available.',
    };
  }

  const changes: string[] = [];
  let uncertain = false;

  for (const f of ctx.changedFiles) {
    if (!SOURCE_EXT_RE.test(f.path) || isTestPath(f.path)) continue;

    const baseContent = ctx.readBaseFile(f.path);
    const headContent = f.status === 'deleted' ? null : ctx.readFile(f.path);
    if (baseContent == null && headContent == null) continue;

    const baseExp = baseContent ? directExports(baseContent, f.path) : EMPTY_EXPORTS;
    const headExp = headContent ? directExports(headContent, f.path) : EMPTY_EXPORTS;
    if (baseExp.uncertain || headExp.uncertain) {
      uncertain = true;
      continue;
    }

    const added = [...headExp.names].filter((n) => !baseExp.names.has(n));
    const removed = [...baseExp.names].filter((n) => !headExp.names.has(n));
    if (baseExp.hasDefault !== headExp.hasDefault) {
      (headExp.hasDefault ? added : removed).push('default');
    }
    if (added.length || removed.length) {
      const parts: string[] = [];
      if (added.length) parts.push(`+${added.join(', +')}`);
      if (removed.length) parts.push(`-${removed.join(', -')}`);
      changes.push(`${f.path} (${parts.join('; ')})`);
    }
  }

  if (changes.length) {
    return {
      verdict: 'CONTRADICTED',
      title: 'Claimed no public API change, but exports changed',
      detail: `Exported symbols changed in: ${changes.join(' | ')}.`,
    };
  }
  if (uncertain) {
    return {
      verdict: 'UNVERIFIED',
      title: 'Public API change could not be fully verified',
      detail: 'Some changed modules use `export *` / CJS exports that cannot be enumerated statically.',
    };
  }
  return {
    verdict: 'PASS',
    title: 'Claim confirmed: no public API change',
    detail: 'No exported symbols were added or removed in changed source files.',
  };
}

/** "no default flip" → no literal default parameter value changed between base and head. */
function verifyNoDefaultFlip(ctx: AnalyzerContext, claim: Claim): VerifierResult {
  if (!ctx.base || !ctx.readBaseFile) {
    return {
      verdict: 'UNVERIFIED',
      title: 'No base ref to compare defaults',
      detail: 'Default-value changes need a base ref to diff against; none was available.',
    };
  }

  const flips: string[] = [];
  for (const f of ctx.changedFiles) {
    if (!SOURCE_EXT_RE.test(f.path) || isTestPath(f.path)) continue;
    const baseContent = ctx.readBaseFile(f.path);
    const headContent = f.status === 'deleted' ? null : ctx.readFile(f.path);
    if (baseContent == null || headContent == null) continue;

    const baseDefaults = collectDefaultParams(baseContent, f.path);
    const headDefaults = collectDefaultParams(headContent, f.path);
    for (const [key, headVal] of headDefaults) {
      if (!baseDefaults.has(key)) continue; // newly-added default is not a flip
      const baseVal = baseDefaults.get(key)!;
      if (baseVal === headVal) continue;
      if (claim.arg && !keyMatchesArg(key, claim.arg)) continue;
      flips.push(`${f.path} ${key} (${baseVal} → ${headVal})`);
    }
  }

  if (flips.length) {
    return {
      verdict: 'CONTRADICTED',
      title: 'Claimed no default flip, but a default changed',
      detail: `Default values changed: ${flips.join(' | ')}.`,
    };
  }
  return {
    verdict: 'PASS',
    title: 'Claim confirmed: no default flip',
    detail: claim.arg
      ? `No literal default for '${claim.arg}' changed in changed source files.`
      : 'No literal default parameter values changed in changed source files.',
  };
}

const verifiers: Record<string, Verifier> = {
  'added-test': verifyAddedTest,
  'added-tests': verifyAddedTest,
  'added-a-test': verifyAddedTest,
  'no-public-api-change': verifyNoPublicApiChange,
  'no-api-change': verifyNoPublicApiChange,
  'no-public-api-changes': verifyNoPublicApiChange,
  'no-default-flip': verifyNoDefaultFlip,
  'no-default-change': verifyNoDefaultFlip,
  'no-defaults-changed': verifyNoDefaultFlip,
};

export const recognizedClaims = Object.keys(verifiers);

export const claimReconciliation: Analyzer = {
  id: 'claim-reconciliation',
  title: 'Claim reconciliation',
  description:
    'Verifies machine-readable PR claims against the diff using deterministic checks (no LLM).',
  kind: 'claim-reconciliation',
  run(ctx: AnalyzerContext): Finding[] {
    const claims = ctx.claims ?? [];
    const findings: Finding[] = [];

    for (const claim of claims) {
      const verifier = verifiers[claim.key];
      const res: VerifierResult = verifier
        ? verifier(ctx, claim)
        : {
            verdict: 'UNVERIFIED',
            title: 'Unrecognized claim',
            detail: `No deterministic verifier for claim '${claim.key}'. Recognized: ${recognizedClaims.join(', ')}.`,
          };

      findings.push({
        analyzer: 'claim-reconciliation',
        verdict: res.verdict,
        file: '(PR claim)',
        line: 0,
        title: res.title,
        detail: res.detail,
        claim: claim.raw,
      });
    }

    return findings;
  },
};
