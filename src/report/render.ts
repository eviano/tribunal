import type { Finding, Report, Verdict } from '../types.js';

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
  const head = `- ${VERDICT_EMOJI[f.verdict]} **${f.title}** — \`${f.file}:${loc}\` _(${f.analyzer})_`;
  return `${head}\n  ${f.detail}`;
}
