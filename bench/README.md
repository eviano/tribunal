# Tribunal benchmark

The benchmark is how Tribunal proves the only thing that makes it trustworthy as a **hard-fail** gate:
that it almost never produces a false `CONTRADICTED`. Per [docs/SPEC.md §7](../docs/SPEC.md), the
calibration — not the orchestration code — is the moat.

## Run it

```bash
npm run bench     # prints the per-case table + aggregate metrics, exits non-zero if targets are missed
npm test          # the same corpus is also asserted in test/bench.test.ts (CI guard)
```

## Metrics

Each case is labeled `defect` (Tribunal should emit ≥1 `CONTRADICTED`) or `clean` (Tribunal must emit
**zero** `CONTRADICTED`). From the confusion matrix:

- **false-positive rate** — clean cases wrongly flagged. **Target: ≤ 2%** (the hard one; a single false
  red is worse than a missed defect).
- **recall** — defects caught. Target: ≥ 90%.
- **precision** — of everything flagged, how much was a real defect.

The corpus is deliberately adversarial on the clean side (large refactors carrying a
`no-public-api-change` claim, tests that assert through helpers) so the false-positive number means
something.

## Plugging in the MSR'26 PR-MCI set

The seed corpus is hand-written. To benchmark against the public **MSR'26 PR-MCI** labeled set (974
annotated PRs), write an adapter that converts each labeled PR into a `BenchCase`
(see [`harness.ts`](harness.ts)) — head/base file contents, the changed paths, any claims from the PR
body — and concatenate them with `cases`. The harness and metrics are unchanged.
