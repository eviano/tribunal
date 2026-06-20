# ⚖️ Tribunal

**A deterministic, no-LLM-in-the-loop CI gate that catches the defects coding agents ship** — tests
that assert nothing, references to symbols that don't exist, and PR claims that contradict what the
diff actually did.

Agents now write both the change *and* a persuasive PR description optimized to sound done. Reviewers
anchor on the prose and rubber-stamp. Tribunal is the deterministic safety net for that failure mode —
not another stochastic reviewer that can be prompt-injected or hallucinate an approval.

> **Status: pre-alpha (M0).** The first analyzer — `assertion-free-test` — and the full
> diff → verdict → exit-code pipeline are working and tested. See [docs/SPEC.md](docs/SPEC.md) for the
> architecture and roadmap.

## The Trust Contract

Tribunal is only useful if a paranoid platform team will let it block a build. That requires hard
guarantees, not vibes:

1. **No LLM is ever in the verification path.** The thing that flips a build red is always
   deterministic code. (A model may *propose* a claim to check; it may never *adjudicate* one.)
2. **Three verdicts:** 🟢 `PASS` · 🟡 `UNVERIFIED` · 🔴 `CONTRADICTED`.
3. **The build is gated ONLY on `CONTRADICTED`,** and only with `--hard-fail`. Absence of a
   contradiction never blocks; `UNVERIFIED` never blocks.
4. **`CONTRADICTED` is a syntactic certainty, never a guess.** If a contradiction can't be *proven*
   from the AST, the verdict degrades to `UNVERIFIED` — never a false red. We would rather miss a real
   defect than block a correct PR.
5. **Reporter-first.** Default mode is a non-blocking PR comment. Teams earn trust in the signal before
   it can break their build.

## Quickstart

```bash
npm install
npm test            # run the suite
npm run check -- check --help
```

Run it against your working changes (report-only):

```bash
npm run check -- check                     # diff working tree vs HEAD
npm run check -- check --base main --head HEAD
npm run check -- check --diff some.patch    # analyze a unified diff file
npm run check -- check --format json
```

Make it block a build (opt-in, gates only on 🔴 CONTRADICTED):

```bash
npm run check -- check --base main --head HEAD --hard-fail
```

## Use it in CI (GitHub Action)

Tribunal ships a reusable composite action that runs on a PR, posts a **sticky comment** with the
report, and (optionally) fails the build — gating **only** on 🔴 CONTRADICTED.

```yaml
# .github/workflows/tribunal.yml
name: Tribunal
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  tribunal:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: eviano/tribunal@v1
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          hard-fail: 'false'   # start in report-only; flip to 'true' once you trust the signal
```

This repo dogfoods its own action — see [.github/workflows/tribunal.yml](.github/workflows/tribunal.yml).

## What M0 catches: `assertion-free-test`

A test the PR added or changed that **can never fail** because it asserts nothing:

```ts
it('validates the input', () => {
  const result = validate(payload);   // 🔴 CONTRADICTED: no assertion — this test can never fail
});
```

- 🟢 **PASS** — an assertion is reachable (directly, or via a local helper Tribunal can follow).
- 🟡 **UNVERIFIED** — no assertion found, but the test calls an external helper that *might* assert.
  Loud, never blocking.
- 🔴 **CONTRADICTED** — a syntactic certainty: the body is empty, has no calls at all, or only calls
  local helpers that themselves cannot assert.

It understands `expect`, `assert`/`node:assert` (incl. named imports like `strictEqual`), chai
(`.should`, `chai.expect`), `sinon.assert.*`, Deno std `assert*`, and AVA/`node:test` context
assertions (`t.is`, `t.deepEqual`, …). Skipped tests (`it.skip`, `it.todo`) are ignored. Only tests
**touched by the diff** are evaluated.

## What M1 adds: `hallucinated-symbol`

Imports the PR added that reference something that doesn't exist:

```ts
import { parseConifg } from './config';   // 🔴 CONTRADICTED: './config' has no export named 'parseConifg'
import { helper } from './utils/missing'; // 🔴 CONTRADICTED: path resolves to no file
import { Client } from 'some-sdk';        // 🟡 UNVERIFIED: package not installed (dependency check is separate)
```

It resolves modules the way the target repo's own `tsconfig.json` does, follows local `export *`
re-exports, and degrades to 🟡 UNVERIFIED whenever exports can't be statically enumerated (CJS,
unresolvable re-exports). Default imports are never flagged (interop synthesizes a default). Scope for
M1 is imports; full identifier/call resolution is a later increment.

## What M3 adds: `claim-reconciliation`

Verifies the agent's **own claims** against the diff — deterministically. Claims are declared in a
machine-readable block (parsing, never NLU), so an unrecognized claim degrades to 🟡 UNVERIFIED and can
never become a false 🔴 CONTRADICTED:

````md
```tribunal
added-test
no-public-api-change
```
````

- `added-test` → 🟢 PASS if the diff adds a test with a reachable assertion; 🔴 CONTRADICTED if it adds
  no test at all; 🟡 UNVERIFIED if a test was added but its assertion can't be detected.
- `no-public-api-change` → compares the exported-symbol set between base and head; 🔴 CONTRADICTED on any
  added/removed export, 🟡 UNVERIFIED when there's no base ref or a module re-exports via `export *`.

Pass claims with `--claims <file>` (a claims file) or `--pr-body <file>` (reads only the fenced block).
Adding a new claim is one entry in the verifier registry. `no-default-flip` is the next planned verifier.

## Benchmark — the moat-proof

Tribunal is only safe as a hard-fail gate if it almost never false-fires. That's measured, not
asserted:

```bash
npm run bench
# cases=16  TP=9 TN=7 FP=0 FN=0
# recall=100.0%  precision=100.0%  false-positive=0.0%
```

The [`bench/`](bench/) corpus is deliberately adversarial on the clean side (big refactors carrying a
`no-public-api-change` claim, tests that assert through helpers) so the **false-positive rate** means
something. It runs in CI via `test/bench.test.ts` and is the regression guard for the Trust Contract.
The public MSR'26 PR-MCI labeled set (974 PRs) plugs in alongside the seed corpus — see
[bench/README.md](bench/README.md).

## Roadmap

| Milestone | Scope |
|-----------|-------|
| **M0** ✅ | scaffold + `assertion-free-test` + pipeline + tests |
| **M1** ✅ | `hallucinated-symbol` — import resolution (nonexistent named exports & relative paths) |
| **M2** ✅ | PR-comment reporter as a GitHub Action |
| **M3** ✅ | claim-reconciliation: `added-test`, `no-public-api-change` (pluggable verifier registry) |
| **M4** ✅ | benchmark harness + adversarial seed corpus + CI guard (currently **0% false-positive**); MSR'26 PR-MCI set pluggable |

## License

MIT
