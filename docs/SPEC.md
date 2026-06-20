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
| `hallucinated-symbol` | calls/imports/identifiers in changed code that **don't resolve** to any definition | ▶ M1 |
| `comment-code-drift` | a comment/docstring that references code which changed (conservative proxy only) | ▶ M2 |

### 5b. Claim-reconciliation analyzers — the durable moat
Parse discrete claims → map each to a **deterministic** verifier. Extraction is **parsing, not NLU**:
prefer a machine-readable claims block (`tribunal.yaml` / a PR-template section) so an extraction miss
degrades to `UNVERIFIED`, never a wrong `CONTRADICTED`.

| claim | deterministic verifier (wrapped) |
|-------|----------------------------------|
| "added a test" | coverage-diff: a new test executes new assertions over changed lines |
| "no public API change" | exported-symbol diff is empty (`api-extractor` / `oasdiff`) |
| "no default change in X" | AST diff of default literals/params is empty |
| "docs updated" | referenced symbols actually changed |

---

## 6. v1 scope (TypeScript/JS only) & milestones

v1 targets **TS/JS only** — one toolchain that also analyzes Tribunal itself (tightest dogfood loop).

- **M0 — scaffold + `assertion-free-test`** ← *this milestone.* End-to-end pipeline: diff →
  analyzer → PASS/UNVERIFIED/CONTRADICTED report → exit code. Fully unit-tested.
- **M1 — `hallucinated-symbol`** resolution via the TS program/type checker.
- **M2 — PR-comment reporter** as a GitHub Action (`npx tribunal check`), default-WARN.
- **M3 — claim-reconciliation** for 3 claim types: *added test*, *no public API change*,
  *no default flip*, behind a machine-readable claims block.
- **M4 — the benchmark** (see §7).

## 7. The benchmark (the moat proof — what "winning" requires)

Reproduce on the public **MSR'26 PR-MCI** labeled set (974 annotated PRs) plus a corpus of known-good
refactors:

- **`CONTRADICTED` precision ≥ 95%**
- **false-`CONTRADICTED` rate < 2%** on known-good refactors
- **a meaningfully low `UNVERIFIED` rate** (the gate adjudicates, it doesn't just shrug)
- **provably zero LLM in the verification path**

This calibration — not the orchestration code — is the moat. It is harder to reproduce than the wiring
and an incumbent fights buyer trust the whole way.

## 8. Out of scope for v1
- Multi-language (Python, Go) — deliberately deferred to protect precision.
- Generic slop checks beyond the three claim-independent analyzers — cede to `aislop`; **compose**.
- The prompt-injection scrubber — cede to Rebuff in v1; revisit when an LLM reviewer is downstream.
- Any LLM call in the adjudication path — permanently out of scope (principle #1).
