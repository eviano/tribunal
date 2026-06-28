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

## Install

[![npm](https://img.shields.io/npm/v/@eviano/tribunal)](https://www.npmjs.com/package/@eviano/tribunal)

```bash
npm i -D @eviano/tribunal
```

Run it against a PR range (report-only by default; gates only on 🔴 CONTRADICTED):

```bash
npx @eviano/tribunal check --base main --head HEAD
npx @eviano/tribunal check                       # diff working tree vs HEAD
npx @eviano/tribunal check --diff some.patch      # analyze a unified diff file
npx @eviano/tribunal check --format json
npx @eviano/tribunal check --base main --head HEAD --hard-fail   # block the build
```

## Develop from source

```bash
npm install
npm test            # run the suite
npm run check -- check --help
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

## SARIF output (GitHub code-scanning alerts)

Tribunal can emit [SARIF](https://docs.oasis-open.org/sarif/) so findings appear as GitHub
code-scanning alerts with proper tracking, dismissal, and filter-by-severity across runs.

```bash
tribunal check --diff pr.diff --format sarif > tribunal.sarif
```

Level mapping (deliberate — matches "gate only on CONTRADICTED"):

| Tribunal verdict | SARIF level |
|---|---|
| 🔴 CONTRADICTED | `error` |
| 🟡 UNVERIFIED | `note` |
| 🟢 PASS | _omitted_ |

Only the blocking verdict becomes an `error` alert; UNVERIFIED is visible but non-noisy. Each finding
carries a stable `partialFingerprints` (derived from analyzer + file + line + claim, **not** from the
prose) so GitHub tracks the same alert across runs — rewording a finding's title won't fork a new one.

Upload it in a workflow (bring your own upload step; the bundled action stays markdown-only to keep its
permission footprint minimal):

```yaml
jobs:
  tribunal-sarif:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # required by upload-sarif
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npx @eviano/tribunal check \
          --base ${{ github.event.pull_request.base.sha }} \
          --head ${{ github.event.pull_request.head.sha }} \
          --format sarif > tribunal.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: tribunal.sarif
          category: tribunal
```

SARIF is data, never a gate — the `--hard-fail` exit code still comes from `exitCode()`. You can run
both: post the markdown comment (via the action) **and** upload SARIF in the same job.

## Configuration (`tribunal.yml`)

Optionally configure Tribunal with a `tribunal.yml` at the repo root (override the path with `--config
<file>` or `TRIBUNAL_CONFIG`). With **no** file, all defaults apply — config is purely additive.

```yaml
# tribunal.yml
analyzers:
  risky-diff-no-test: false      # disable an analyzer (default: all enabled)
generated-paths:                 # EXTRA generated paths, appended to the built-ins
  - vendor-generated/
  - "**/*.gen.ts"
```

- **`analyzers`** — a map of analyzer id → boolean. Default: every analyzer enabled. Disabling
  `claim-reconciliation` just stops claim checks; claim-independent analyzers still run. **Unknown ids are
  rejected** (typo guard): a misspelled key fails loud rather than silently no-op'ing.
- **`generated-paths`** — extra generated/build-output patterns, **appended** to the built-ins
  (`dist/`, `action-dist/`, `*.min.js`, …). Config can only *add* coverage — never replace — so a user
  can't accidentally drop the `dist/` safety net. Patterns may be dir-prefixes (`vendor-generated/`),
  suffixes (`.gen.ts`), or simple globs (`**/*.gen.ts`, `src/generated/*`).

A present-but-malformed file (bad key, unknown analyzer, bad YAML) **fails loud** with a clear error
pointing at the line — it never silently degrades to defaults.

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

## What it also ships: `risky-diff-no-test`

A **signal** analyzer (never a gate) that fires when a PR touches a security-relevant area but adds no
correlated asserting test — the "silence is not an escape hatch" check. An agent that changes auth,
crypto, or payment code and ships nothing to cover it gets a finding even when it wrote no PR body:

```ts
// src/auth.ts — changed by the PR
export function login(user, pass) { return user === pass; }   // 🟡 UNVERIFIED: risky area ('auth'),
                                                              //              no correlated asserting test
```

- 🟡 **UNVERIFIED** — a risky area (path segment *or* a changed-line identifier token: `auth`,
  `crypto`, `payment`, `token`, `secret`, …) was touched but no correlated asserting test was detected.
  **Never blocks** — "is this risky?" is semantic, and a semantic guess may never flip a build red.
- 🟢 **PASS** — risky area touched **and** a correlated asserting test was added (test basename stem
  shares a token with the risky file, e.g. `auth.ts` ↔ `auth.test.ts`).

It tokenizes (camelCase / kebab / snake) and matches on whole tokens, not substrings, so `authors.ts`
and `tokenize.ts` are correctly *not* flagged. Because it can only ever emit PASS/UNVERIFIED, it is safe
to run under `--hard-fail`.

**Generated-path skip.** A bundled artifact (e.g. `action-dist/cli.cjs`, `dist/*.min.js`) carries the
project's own risky vocab but isn't human-authored source a reviewer can act on, so flagging it is
noisy. This analyzer **skips generated/build-output paths by default** (`dist/`, `action-dist/`,
`build/`, `out/`, `.next/`, `coverage/`, `node_modules/`, and `*.min.{js,cjs,mjs}` / `*.bundle.js`).
Pass `--no-skip-generated` (or set `TRIBUNAL_NO_SKIP_GENERATED=1`) to re-enable flagging them — an
opinionated default must never silently suppress a file you want checked.

## `comment-code-drift`

A **signal** analyzer (never a gate) that flags a comment/docstring which references a symbol whose
**definition changed** in the diff (body edit, rename, or removal), where the comment itself wasn't
freshly added. Catches the classic agent failure: it edits a function's behavior or renames it, but
leaves the docstring describing the old behavior/name.

```ts
// src/greet.ts
// greet: returns a friendly greeting        ← pre-existing comment (not added this PR)
export function greet() { return 'hello'; }  // ← body changed 'hi' → 'hello'
// → 🟡 UNVERIFIED: comment mentions 'greet', whose definition changed. Verify the wording is accurate.
```

- 🟡 **UNVERIFIED** — a comment (in the changed file **or** another changed file) mentions a changed
  symbol by its **exact identifier token**, and the comment line was **not added** in this diff (a
  freshly-added comment is unlikely stale — the key false-positive cut).
- It only fires when a **base ref** is available (it compares base vs head ASTs to find changed
  declarations). With no base ref, it's silent.
- Like the other signal analyzers it **never blocks**: comment staleness is semantic, so it emits
  PASS/UNVERIFIED only and is safe under `--hard-fail`.

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
- `no-default-flip` → compares literal default parameter values between base and head (scope to one with
  `no-default-flip: paramName`); 🔴 CONTRADICTED when a default silently changed.

Pass claims with `--claims <file>` (a claims file) or `--pr-body <file>` (reads only the fenced block).
Adding a new claim is one entry in the verifier registry.

## `tribunal propose` — let an LLM PROPOSE claims (it never adjudicates)

No agent emits the ` ```tribunal ` convention today, so `claim-reconciliation` (above) does nothing on a
normal agent PR. `propose` closes that gap: it asks an LLM to *suggest* which claims a reviewer should
ask the deterministic engine to check, then writes a ` ```tribunal ` block that `check` consumes.

This is the narrow, Trust-Contract-compliant use of an LLM: it **proposes**; deterministic code
**adjudicates**. The LLM is never in the verification path.

**The two-step loop:**

```bash
# 1) propose — the LLM reads the diff and suggests claims (writes claims.md)
tribunal propose --diff pr.diff \
  --endpoint https://api.openai.com/v1 --model gpt-4o-mini \
  --allow-send-diff --out claims.md

# 2) check — deterministic engine verifies the proposed claims against the diff
tribunal check --diff pr.diff --pr-body claims.md --hard-fail
```

`propose` is pluggable: point `--endpoint` at any OpenAI-compatible chat-completions URL (OpenAI,
OpenRouter, a local Ollama / LM Studio server). Configure via flags or `TRIBUNAL_ENDPOINT` /
`TRIBUNAL_MODEL` / `TRIBUNAL_API_KEY`.

**The send-guard.** The diff is your source code, and sending it to an LLM endpoint is an outward-facing
publish. So `propose` **refuses to send by default** — without `--allow-send-diff` it prints the prompt
for review and sends *nothing*. Add the flag (or `TRIBUNAL_ALLOW_SEND_DIFF=1`) only when you've chosen
the endpoint and accept that the diff leaves the machine.

**Why this can't break the gate.** Two architectural guarantees hold even if the model hallucinates or is
prompt-injected:

1. `propose` is a separate command and code path. It never imports or calls any verifier, `runTribunal`,
   or `exitCode`. It only reads a diff and writes a claims block.
2. The model can only ever emit claim *keys*. Keys outside the recognized set are downgraded to
   🟡 UNVERIFIED by the verifier registry — never 🔴 CONTRADICTED. Since `--hard-fail` gates only on
   CONTRADICTED, **the LLM path cannot manufacture a false red**, no matter what it returns. (A *legitimate*
   CONTRADICTED can still appear — that's the deterministic checker doing its job, which is the point.)

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
| **M3** ✅ | claim-reconciliation: `added-test`, `no-public-api-change`, `no-default-flip` (pluggable registry) |
| **M4** ✅ | benchmark harness + adversarial seed corpus + CI guard (currently **0% false-positive**); MSR'26 PR-MCI set pluggable |

## License

MIT
