# Tribunal — Build Spec (v0.1)

> A deterministic, **no-LLM-in-the-verification-path** CI gate that catches the defects coding agents
> ship: tests that assert nothing, references to symbols that don't exist, and PR claims that
> contradict what the diff actually did.

This spec is the contract the code is built against. It encodes the strategic decisions that came out
of the validation army — the parts that, if violated, turn Tribunal into just another stochastic
reviewer or a build-breaking nuisance that gets ripped out by Friday.

---

## 1. The problem & why now

Agents now generate **both** the change **and** a persuasive justification optimized to sound done
("added input validation, updated tests, no behavior change to auth"). Reviewers anchor on the prose
and rubber-stamp. The claims routinely diverge from the diff: the "added test" asserts nothing, "no
behavior change" silently flipped a default, the diff calls a function that doesn't exist, a docstring
now lies. At dozens of agent PRs/day nobody reconciles narrative vs. diff by hand.

The industry reflex — "just add an LLM reviewer" — is itself uncalibrated: it hallucinates approvals,
is a prompt-injection surface, and gives false confidence. **Tribunal is the deterministic safety net
for the known agent-defect distribution**, not another opinion.

## 2. Why this can be an OSS project that survives

The moat is **structural, not technical**: the vendor selling you the agent has a permanent conflict
of interest in shipping the tool whose job is to catch its own agent lying. A paranoid platform/DevEx
team will only **hard-fail a build** on a verdict that is deterministic, inspectable, and
non-injectable. That is a lane incumbents *can't* occupy for incentive reasons — which is rarer and
more durable than a feature lead.

---

## 3. Non-negotiable design principles (the Trust Contract)

These are load-bearing. Every analyzer and every line of the gate logic must obey them.

1. **Zero LLM in the verification path.** A model may *propose* a claim to check; a model may never
   *adjudicate* whether a check passed. The thing that flips a build red is always deterministic code.
2. **Three verdicts, always:** `PASS` · `UNVERIFIED` · `CONTRADICTED`.
3. **Gate ONLY on `CONTRADICTED`.** The absence of `CONTRADICTED` never blocks. `UNVERIFIED` is loud
   but non-blocking. This is the fails-safe guarantee.
4. **`CONTRADICTED` is a syntactic certainty, never a semantic inference.** If a contradiction cannot
   be *proven* from the AST/diff, the verdict is `UNVERIFIED` — **never** `PASS` and **never**
   `CONTRADICTED`. We would rather miss a real defect (under-flag) than block a correct PR
   (over-flag). The false-`CONTRADICTED` budget is ~0.
5. **Reporter-first.** Default mode is a non-blocking PR comment (exit 0). `--hard-fail` is opt-in and
   per-check. A team earns trust in the signal *before* it can break their build.
6. **Compose, don't re-implement.** Wrap battle-tested verifiers (`oasdiff`, `api-extractor`,
   coverage-diff, `aislop`) rather than rebuilding them. Tribunal's novelty is the
   claim→verifier orchestration and the fails-safe contract, not the analyzers themselves.
7. **Absence of a claim is not an escape hatch.** For security-relevant categories (auth, defaults,
   exported surface), a risky diff with no asserting test is a finding *regardless* of whether the
   agent narrated anything — otherwise the dominant adversarial strategy is silence.

---

## 4. Architecture

```
  git diff / --diff file
          │
          ▼
   ┌─────────────┐   ChangedFile[]   ┌──────────────┐   Finding[]   ┌────────────┐
   │  diff layer │ ───────────────▶  │  analyzers   │ ───────────▶  │   report   │
   │ (parse +    │                   │  (registry)  │               │  + render  │
   │  git shell) │   AnalyzerContext │              │               │  + exit    │
   └─────────────┘                   └──────────────┘               └────────────┘
```

- **diff layer** (`src/diff/`): turns a unified diff (from `git` or a `--diff` file) into
  `ChangedFile[]` with the exact set of added/modified line numbers in the new file. Provides
  `readFile()` over the working tree (head checkout).
- **analyzers** (`src/analyzers/`): each implements `Analyzer.run(ctx) → Finding[]`. Two families
  (see §5). Pure, deterministic, no network, no model.
- **report** (`src/report/`): aggregates findings into a `Report`, renders Markdown (PR comment) or
  JSON, and computes the exit code — non-zero **only** when `--hard-fail` is set **and** there is at
  least one `CONTRADICTED` among enabled checks.

Core types live in `src/types.ts`: `Verdict`, `Finding`, `ChangedFile`, `AnalyzerContext`,
`Analyzer`, `Report`.

---

## 5. Analyzer families

### 5a. Claim-independent analyzers — the day-one on-ramp
Fire whether or not the agent narrated anything; near-false-positive-free; this is real value before
the claim layer exists.

| id | what it catches | status |
|----|-----------------|--------|
| `assertion-free-test` | tests added/changed by the PR that contain **no assertion** and can never fail | ✅ **built (M0)** |
| `hallucinated-symbol` | imports the PR added that reference a module path or named export that **doesn't exist** (identifier/call resolution is a later extension) | ✅ **built (M1 — import subset)** |
| `risky-diff-no-test` | a diff that touches a security-relevant area (auth, crypto, payments, …) but adds **no correlated asserting test** — the SPEC §3.7 "silence is not an escape hatch" signal | ✅ **built (signal-only)** |
| `comment-code-drift` | a comment/docstring that references code which changed (conservative proxy only) | ▶ later |

> **`risky-diff-no-test` is a signal analyzer, never a gate.** "Is this code risky?" is a *semantic*
> judgement, and §3.4 forbids semantic `CONTRADICTED` — so it emits only `PASS` / `UNVERIFIED`, never
> `CONTRADICTED`. It is therefore safe to run under `--hard-fail`: it cannot cause a false red. The
> value is that a risky diff with no test becomes a loud, non-blocking finding even when the agent
> said nothing at all (§3.7: the dominant adversarial strategy is silence).

### 5b. Claim-reconciliation analyzers — the durable moat
Parse discrete claims → map each to a **deterministic** verifier. Extraction is **parsing, not NLU**:
prefer a machine-readable claims block (`tribunal.yaml` / a PR-template section) so an extraction miss
degrades to `UNVERIFIED`, never a wrong `CONTRADICTED`.

| claim key | deterministic verifier | status |
|-----------|------------------------|--------|
| `added-test` | the diff adds a test; PASS if it has a reachable assertion, CONTRADICTED if no test block appears at all | ✅ **built (M3)** |
| `no-public-api-change` | exported-symbol set is identical between base and head for changed source files | ✅ **built (M3)** |
| `no-default-flip` | literal default parameter values are unchanged between base and head (optional `: paramName` scope) | ✅ **built** |
| `docs-updated` | referenced symbols actually changed | ▶ later |

Extraction is parsing, not NLU: claims come from a ```` ```tribunal ```` fenced block in the PR body
(or a claims file). An unrecognized claim key degrades to `UNVERIFIED` — it can never become a false
`CONTRADICTED`. Verifying `no-public-api-change` requires the base tree, read via `git show base:path`;
when no base ref is available the claim degrades to `UNVERIFIED`.

---

## 6. v1 scope (TypeScript/JS only) & milestones

v1 targets **TS/JS only** — one toolchain that also analyzes Tribunal itself (tightest dogfood loop).

- **M0 — scaffold + `assertion-free-test`** ← *this milestone.* End-to-end pipeline: diff →
  analyzer → PASS/UNVERIFIED/CONTRADICTED report → exit code. Fully unit-tested.
- **M1 — `hallucinated-symbol`** ✅ *(import subset)*: nonexistent named exports and unresolvable
  relative paths, resolved with the target repo's own tsconfig. Full identifier/call resolution via the
  TS type checker is deferred (higher false-positive risk; demands the whole program).
- **M2 — PR-comment reporter** as a GitHub Action (`npx tribunal check`), default-WARN.
- **M3 — claim-reconciliation** ✅: `added-test`, `no-public-api-change`, and `no-default-flip`, behind
  a machine-readable ```` ```tribunal ```` claims block; pluggable claim→verifier registry.
- **M4 — the benchmark** ✅ *(harness + seed corpus)*: a labeled-corpus harness, an adversarial seed
  corpus, and a CI guard that fails on any false `CONTRADICTED` (see §7 and `bench/`). The MSR'26
  PR-MCI labeled set plugs in via an adapter.

## 7. The benchmark (the moat proof — what "winning" requires)

Reproduce on the public **MSR'26 PR-MCI** labeled set (974 annotated PRs) plus a corpus of known-good
refactors:

- **`CONTRADICTED` precision ≥ 95%**
- **false-`CONTRADICTED` rate < 2%** on known-good refactors
- **a meaningfully low `UNVERIFIED` rate** (the gate adjudicates, it doesn't just shrug)
- **provably zero LLM in the verification path**

This calibration — not the orchestration code — is the moat. It is harder to reproduce than the wiring
and an incumbent fights buyer trust the whole way.

**Status:** the harness (`bench/`) and an adversarial seed corpus exist now, with a CI guard that fails
on any false `CONTRADICTED`. Current seed-corpus numbers: 16 cases, 0% false-positive, 100% recall.
The MSR'26 PR-MCI labeled set plugs in via a `BenchCase` adapter (see `bench/README.md`).

## 8. Out of scope for v1
- Multi-language (Python, Go) — deliberately deferred to protect precision.
- Generic slop checks beyond the three claim-independent analyzers — cede to `aislop`; **compose**.
- The prompt-injection scrubber — cede to Rebuff in v1; revisit when an LLM reviewer is downstream.
- Any LLM call in the adjudication path — permanently out of scope (principle #1).
