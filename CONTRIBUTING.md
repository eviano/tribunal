# Contributing to Tribunal

Tribunal is a deterministic, no-LLM CI gate for agent-authored PRs. Contributions are welcome —
especially new analyzers, precision improvements, and corpus cases that would currently false-fire.

## The one rule that governs everything

**The Trust Contract (see [`docs/SPEC.md`](docs/SPEC.md) §3).** Every change must preserve it:

- The build gates **only** on 🔴 `CONTRADICTED`, and only with `--hard-fail`.
- `CONTRADICTED` must be a **syntactic certainty** — never a semantic inference. If a check can't be
  certain, it must degrade to 🟡 `UNVERIFIED` (loud, non-blocking), not guess.
- **No LLM in the verification path.** `tribunal propose` may *suggest* claims; deterministic code
  *adjudicates* them. If your change introduces any model call into the verdict path, it's a regression.

If your change could plausibly introduce a false `CONTRADICTED`, it doesn't belong here.

## Development

```bash
npm install
npm test           # vitest — the full unit suite (must stay green)
npm run typecheck  # tsc --noEmit
npm run bench      # the seed corpus — targets FP=0, FN=0 (see bench/README.md)
npm run build      # emit dist/
npm run build:action  # rebuild the self-contained action bundle (action-dist/cli.cjs)
```

The repo dogfoods its own action on every PR — open one and Tribunal will post a sticky comment
adjudicating your diff. That comment is part of the review surface.

## Adding an analyzer

Analyzers live in `src/analyzers/` and implement the `Analyzer` interface (`src/types.ts`):

```ts
interface Analyzer {
  id: string;
  title: string;
  description: string;
  kind: 'claim-independent' | 'claim-dependent';
  run(ctx: AnalyzerContext): Finding[];
}
```

1. **Pick your verdict semantics up front.** Can your check produce a *syntactic certainty* for a
   violation? → it may emit `CONTRADICTED`. Is the judgement *semantic* (risk, staleness, intent)? →
   it must be a **signal analyzer** that emits only `PASS`/`UNVERIFIED`, never `CONTRADICTED`. See
   `riskyDiffNoTest.ts` and `commentCodeDrift.ts` for the pattern — they literally cannot block.
2. **Add the analyzer** in `src/analyzers/<name>.ts`. Reuse helpers (`isTestPath`, `assertionFreeTest`,
   `paths.ts`) rather than duplicating.
3. **Register it** in `src/analyzers/index.ts` and export from `src/index.ts`.
4. **Test it** in `test/<name>.test.ts`. Cover the verdict matrix and, if it's a signal analyzer, a
   "never emits `CONTRADICTED`" battery.
5. **If it's `CONTRADICTED`-bearing**, add adversarial *clean* cases to `bench/cases.ts` that a naive
   checker would false-flag, so the FP=0 budget is defended. Signal-only (UNVERIFIED) analyzers don't
   need corpus entries — they can't change the blocking metric.
6. **Rebuild the action bundle** (`npm run build:action`) so the bundle-freshness CI check passes.

## Adding a bench case

Cases live in `bench/cases.ts`. A *clean* case (`label: 'clean'`) must produce no `CONTRADICTED`; a
*defect* case (`label: 'defect'`) must produce at least one. The harness scores `FP=0, FN=0` — any
case that breaks that budget is a real precision/recall regression, not a flaky test.

## Committing & PRs

- Conventional-commit-style messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Keep PRs focused; one analyzer or one fix per PR makes review (and the dogfood verdict) cleaner.
- Don't bump the published version — that's a maintainer release step.

## What's out of scope

- Any LLM in the adjudication path (Trust Contract principle #1).
- Softening `CONTRADICTED` into "probably wrong" — the budget is ~0 false reds, by design.
