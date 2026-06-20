import { cases } from './cases.js';
import { runCase, summarize, TARGETS, type CaseResult } from './harness.js';

const OUTCOME_EMOJI: Record<CaseResult['outcome'], string> = {
  TP: '✅',
  TN: '✅',
  FP: '❌',
  FN: '⚠️',
};

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function main(): void {
  const results = cases.map(runCase);

  process.stdout.write('Tribunal benchmark — seed corpus\n');
  process.stdout.write('─'.repeat(72) + '\n');
  for (const r of results) {
    const counts = `🔴${r.contradicted} 🟡${r.unverified} 🟢${r.pass}`;
    process.stdout.write(
      `${OUTCOME_EMOJI[r.outcome]} ${r.outcome.padEnd(2)} ${r.id.padEnd(28)} ${counts.padEnd(12)} ${r.description}\n`,
    );
  }
  process.stdout.write('─'.repeat(72) + '\n');

  const s = summarize(results);
  process.stdout.write(
    `cases=${s.total}  TP=${s.tp} TN=${s.tn} FP=${s.fp} FN=${s.fn}\n` +
      `recall=${pct(s.recall)}  precision=${pct(s.precision)}  false-positive=${pct(s.falsePositiveRate)}\n`,
  );

  const failures: string[] = [];
  if (s.falsePositiveRate > TARGETS.maxFalsePositiveRate) {
    failures.push(
      `false-positive rate ${pct(s.falsePositiveRate)} exceeds target ${pct(TARGETS.maxFalsePositiveRate)}`,
    );
  }
  if (s.recall < TARGETS.minRecall) {
    failures.push(`recall ${pct(s.recall)} below target ${pct(TARGETS.minRecall)}`);
  }

  if (failures.length) {
    process.stdout.write(`\nFAIL:\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
  process.stdout.write('\nPASS — all targets met.\n');
  process.exit(0);
}

main();
