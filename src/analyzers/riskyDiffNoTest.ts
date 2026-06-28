import ts from 'typescript';
import type { Analyzer, AnalyzerContext, ChangedFile, Finding } from '../types.js';
import { assertionFreeTest } from './assertionFreeTest.js';

/**
 * `risky-diff-no-test` — a claim-independent *signal* analyzer that implements SPEC §3.7:
 * "absence of a claim is not an escape hatch. For security-relevant categories (auth, defaults,
 * exported surface), a risky diff with no asserting test is a finding regardless of whether the agent
 * narrated anything — otherwise the dominant adversarial strategy is silence."
 *
 * The verdict here is a deliberate, load-bearing design choice:
 *
 *   - This analyzer **NEVER emits CONTRADICTED.** "Is this code risky?" is a *semantic* judgement, and
 *     SPEC §3.4 forbids semantic CONTRADICTED (the false-CONTRADICTED budget is ~0). Risk is inferred
 *     from path/identifier tokens, which is a heuristic, not a syntactic certainty. So the only possible
 *     verdicts are PASS and UNVERIFIED — it is a *signal* analyzer, never a *gate*. It is therefore safe
 *     to ship under `--hard-fail`: it can never cause a false red.
 *
 *   - 🟢 PASS    — the diff touches a risky area AND adds a correlated asserting test.
 *   - 🟡 UNVERIFIED — the diff touches a risky area but adds no correlated asserting test. Loud, never
 *                  blocking. A reviewer should confirm coverage; the analyzer refuses to block on a guess.
 *   - (no finding) — the diff touches no risky area.
 *
 * Reuses `assertionFreeTest` for test/assertion detection rather than duplicating it.
 */

/** Security-relevant vocabulary. Matched on path SEGMENTS and identifier TOKENS (never substrings). */
const RISKY_VOCAB = new Set([
  'auth', 'login', 'logout', 'signin', 'signup', 'password', 'passwd', 'credential', 'secret',
  'token', 'crypto', 'cipher', 'hash', 'hmac', 'jwt', 'session', 'cookie', 'permission', 'rbac',
  'acl', 'privilege', 'escalate', 'admin', 'payment', 'billing', 'checkout', 'stripe', 'paypal',
  'sql', 'injection', 'csrf', 'xss',
]);

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_RE = /(^|[./\\])(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_RE = /(^|[/\\])(__tests__|tests?)[/\\]/i;

function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path) || (TEST_DIR_RE.test(path) && SOURCE_EXT_RE.test(path));
}

/**
 * Split an arbitrary string into lowercase tokens: camelCase / PascalCase boundaries, and any non-alnum
 * run (`-`, `_`, `.`, `/`, etc.). `verifyPassword` → [`verify`, `password`]; `user-auth.ts` →
 * [`user`, `auth`, `ts`]; `billing/checkout` → [`billing`, `checkout`]. We never substring-match, so
 * `authors.ts` → [`authors`, `ts`] does NOT hit `auth` and `tokenize` does NOT hit `token`.
 */
function tokenize(s: string): string[] {
  // Insert a break before each uppercase letter preceded by a lowercase letter/digit (camel/Pascal),
  // then split on any run of non-alphanumeric characters.
  const spaced = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function touchesRiskyVocab(...parts: string[]): boolean {
  for (const part of parts) {
    for (const tok of tokenize(part)) {
      if (RISKY_VOCAB.has(tok)) return true;
    }
  }
  return false;
}

/** The basename stem without extension, used for risky↔test correlation. `auth.test.ts` → `auth`. */
function basenameStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  const noExt = base.replace(/\.[cm]?[jt]sx?$/i, '');
  // Strip the conventional `.test` / `.spec` suffix so `auth.test.ts` and `auth.ts` share stem `auth`.
  return noExt.replace(/\.(test|spec)$/i, '');
}

function tokensOfStem(stem: string): Set<string> {
  return new Set(tokenize(stem));
}

/** Two stems are "correlated" when they share any non-trivial token (length ≥ 3). */
function stemsCorrelated(a: string, b: string): boolean {
  const ta = tokensOfStem(a);
  for (const t of tokensOfStem(b)) {
    if (t.length >= 3 && ta.has(t)) return true;
  }
  return false;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Collect identifier tokens that appear on added/modified lines of a source file, so a risky identifier
 * (e.g. `verifyPassword`) is caught even when the file path itself is non-risky. Tokens come from
 * Identifier and StringLiteral nodes whose source span overlaps the diff's added lines.
 */
function changedLineTokens(content: string, path: string, addedLines: Set<number>): string[] {
  if (addedLines.size === 0) return [];
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const toks: string[] = [];

  const onLine = (pos: number): boolean => {
    const start = sf.getLineAndCharacterOfPosition(pos).line + 1;
    return addedLines.has(start);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && onLine(node.getStart(sf))) {
      toks.push(node.text);
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      onLine(node.getStart(sf))
    ) {
      toks.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return toks;
}

interface RiskyHit {
  /** Repo-relative path of the risky source file. */
  path: string;
  /** The token that matched (for the finding detail). */
  token: string;
  /** 1-based line of the match (path segment → first added line; identifier → its line). */
  line: number;
}

/** Find risky source files touched by the diff (path segment OR a changed-line identifier token). */
function findRiskyHits(ctx: AnalyzerContext): RiskyHit[] {
  const hits: RiskyHit[] = [];
  for (const f of ctx.changedFiles) {
    if (f.status === 'deleted' || isTestPath(f.path)) continue;
    if (!SOURCE_EXT_RE.test(f.path)) continue;

    // 1) Path-segment match (cheap, no parse). Line = first added line if any, else 1.
    if (touchesRiskyVocab(f.path)) {
      const matched = tokenize(f.path).find((t) => RISKY_VOCAB.has(t))!;
      const firstAdded = f.addedLines.size ? Math.min(...f.addedLines) : 1;
      hits.push({ path: f.path, token: matched, line: firstAdded });
      continue;
    }

    // 2) Identifier-token match on changed lines (requires parsing the file).
    const content = ctx.readFile(f.path);
    if (content == null) continue;
    for (const tok of changedLineTokens(content, f.path, f.addedLines)) {
      const lower = tokenize(tok);
      const hit = lower.find((t) => RISKY_VOCAB.has(t));
      if (hit) {
        hits.push({ path: f.path, token: hit, line: 1 });
        break; // one hit per file is enough for the signal
      }
    }
  }
  return hits;
}

/**
 * Reuse the assertion-free-test analyzer to find asserting tests added by the diff, then keep only
 * those correlated with a risky file by stem token. This avoids a misleading PASS when an unrelated
 * test was added elsewhere in the PR.
 */
function hasCorrelatedAssertingTest(risky: RiskyHit): boolean {
  const riskyStem = basenameStem(risky.path);
  const findings = assertionFreeTest.run(ctxHolder);
  return findings.some(
    (f) => f.verdict === 'PASS' && stemsCorrelated(riskyStem, basenameStem(f.file)),
  );
}

// `assertionFreeTest.run` needs the full AnalyzerContext. We pass it in via a holder because the
// correlation helper is called per-hit and we don't want to thread ctx through every helper.
let ctxHolder: AnalyzerContext;

export const riskyDiffNoTest: Analyzer = {
  id: 'risky-diff-no-test',
  title: 'Risky change without a correlated test',
  description:
    'Signals a diff that touches a security-relevant area (auth, crypto, payments, …) but adds no ' +
    'correlated asserting test. Never blocks: risk is semantic, so it emits PASS/UNVERIFIED only.',
  kind: 'claim-independent',
  run(ctx: AnalyzerContext): Finding[] {
    ctxHolder = ctx;
    const hits = findRiskyHits(ctx);
    const findings: Finding[] = [];

    for (const hit of hits) {
      const correlated = hasCorrelatedAssertingTest(hit);
      if (correlated) {
        findings.push({
          analyzer: 'risky-diff-no-test',
          verdict: 'PASS',
          file: hit.path,
          line: hit.line,
          title: 'Risky change has a correlated test',
          detail:
            `The diff touches a risky area ('${hit.token}') in ${hit.path} and adds a correlated ` +
            `asserting test. Coverage looks intentional; this is informational only.`,
        });
      } else {
        findings.push({
          analyzer: 'risky-diff-no-test',
          verdict: 'UNVERIFIED',
          file: hit.path,
          line: hit.line,
          title: 'Risky change with no correlated test',
          detail:
            `The diff touches a risky area ('${hit.token}') in ${hit.path}, but no correlated ` +
            `asserting test was detected. 'Risky' is a heuristic (path/identifier tokens), not a ` +
            `certainty, so this never blocks — verify coverage manually.`,
        });
      }
    }

    return findings;
  },
};

// Exposed for unit tests.
export const __test__ = { tokenize, touchesRiskyVocab, basenameStem, stemsCorrelated, RISKY_VOCAB };
