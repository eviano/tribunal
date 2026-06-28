import type { Finding, Report, Verdict } from '../types.js';
import { createHash } from 'node:crypto';

const VERDICT_EMOJI: Record<Verdict, string> = {
  CONTRADICTED: '🔴',
  UNVERIFIED: '🟡',
  PASS: '🟢',
};

export function buildReport(findings: Finding[], analyzersRun: number): Report {
  const counts: Record<Verdict, number> = { PASS: 0, UNVERIFIED: 0, CONTRADICTED: 0 };
  for (const f of findings) counts[f.verdict]++;
  return { findings, counts, analyzersRun };
}

/**
 * The build is gated ONLY on CONTRADICTED, and ONLY when `--hard-fail` is set. This is the fails-safe
 * guarantee from the Trust Contract: absence of CONTRADICTED never blocks, and UNVERIFIED never blocks.
 */
export function exitCode(report: Report, hardFail: boolean): number {
  return hardFail && report.counts.CONTRADICTED > 0 ? 1 : 0;
}

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

/** Markdown intended for a PR comment: blocking findings first, PASS collapsed to a count. */
export function renderMarkdown(report: Report, hardFail: boolean): string {
  const { counts } = report;
  const blocking = report.findings.filter((f) => f.verdict === 'CONTRADICTED');
  const unverified = report.findings.filter((f) => f.verdict === 'UNVERIFIED');

  const lines: string[] = [];
  lines.push('## ⚖️ Tribunal');
  lines.push('');
  lines.push(
    `${VERDICT_EMOJI.CONTRADICTED} **${counts.CONTRADICTED} contradicted** · ` +
      `${VERDICT_EMOJI.UNVERIFIED} ${counts.UNVERIFIED} unverified · ` +
      `${VERDICT_EMOJI.PASS} ${counts.PASS} pass`,
  );
  lines.push('');

  if (blocking.length > 0) {
    lines.push('### 🔴 Contradicted — these are deterministic, blocking findings');
    lines.push('');
    for (const f of blocking) lines.push(renderFinding(f));
    lines.push('');
  }

  if (unverified.length > 0) {
    lines.push('### 🟡 Unverified — could not be decided; not blocking');
    lines.push('');
    for (const f of unverified) lines.push(renderFinding(f));
    lines.push('');
  }

  if (blocking.length === 0 && unverified.length === 0) {
    lines.push('No issues found in changed files. ✅');
    lines.push('');
  }

  const gate =
    counts.CONTRADICTED > 0
      ? hardFail
        ? '**Result: FAIL** — at least one contradicted finding and `--hard-fail` is on.'
        : '**Result: pass (report-only)** — contradictions found, but `--hard-fail` is off.'
      : '**Result: pass** — no contradictions.';
  lines.push('---');
  lines.push(gate);
  lines.push('');
  lines.push(
    '<sub>Tribunal gates only on 🔴 CONTRADICTED (a syntactic certainty). 🟡 UNVERIFIED never blocks. ' +
      'No LLM is in the verification path.</sub>',
  );

  return lines.join('\n');
}

function renderFinding(f: Finding): string {
  const loc = f.endLine && f.endLine !== f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
  const where = f.claim ? `claim: \`${f.claim}\`` : `\`${f.file}:${loc}\``;
  const head = `- ${VERDICT_EMOJI[f.verdict]} **${f.title}** — ${where} _(${f.analyzer})_`;
  return `${head}\n  ${f.detail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SARIF (Static Analysis Results Interchange Format) v2.1.0 output.
//
// Designed so Tribunal findings can be posted as GitHub code-scanning alerts via
// github/codeql-action/upload-sarif, with proper tracking/dismissal across runs.
//
// Verdict → SARIF level mapping (deliberate, matches the Trust Contract's "gate only on
// CONTRADICTED"): CONTRADICTED → error, UNVERIFIED → note, PASS → omitted. Only the blocking verdict
// becomes an alert entry; UNVERIFIED is visible but non-noisy. SARIF is DATA, never a gate — the gate
// stays in exitCode().
// ─────────────────────────────────────────────────────────────────────────────

const SARIF_LEVEL: Record<Verdict, 'error' | 'note' | null> = {
  CONTRADICTED: 'error',
  UNVERIFIED: 'note',
  PASS: null,
};

const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/schemas/sarif-schema-2.1.0.json';

/**
 * A stable, content-addressed fingerprint for a finding so GitHub can track the same alert across runs
 * (reopen/dismiss/stable identity). Derived from the analyzer + file + line + claim — deliberately NOT
 * from the prose (title/detail), which we may reword without wanting to fork a new alert.
 */
function sarifFingerprint(f: Finding): string {
  const material = [f.analyzer, f.file, String(f.line), f.claim ?? ''].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Render the report as a SARIF Log v2.1.0 JSON string. Each analyzer becomes a `rule`; each
 * CONTRADICTED/UNVERIFIED finding becomes a `result` (PASS findings are omitted).
 */
export function renderSarif(report: Report): string {
  // One rule per analyzer that produced a non-PASS finding, so GitHub groups alerts by analyzer.
  const ruleAnalyzers = Array.from(
    new Set(
      report.findings.filter((f) => SARIF_LEVEL[f.verdict] !== null).map((f) => f.analyzer),
    ),
  );
  const rules = ruleAnalyzers.map((id) => ({
    id,
    name: id,
    shortDescription: { text: `Tribunal analyzer: ${id}` },
  }));

  const results = report.findings
    .filter((f) => SARIF_LEVEL[f.verdict] !== null)
    .map((f) => {
      const region: { startLine: number; endLine?: number } = { startLine: f.line };
      if (f.endLine && f.endLine !== f.line) region.endLine = f.endLine;
      return {
        ruleId: f.analyzer,
        level: SARIF_LEVEL[f.verdict] as 'error' | 'note',
        message: { text: `${f.title} — ${f.detail}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: f.file },
              region,
            },
          },
        ],
        partialFingerprints: { tribunal: sarifFingerprint(f) },
      };
    });

  const log = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'tribunal',
            informationUri: 'https://github.com/eviano/tribunal',
            rules,
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(log, null, 2);
}
