# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Trust Contract (see [`docs/SPEC.md`](docs/SPEC.md) §3) governs every release: the build gates only
on 🔴 `CONTRADICTED` (a syntactic certainty); 🟡 `UNVERIFIED` never blocks; no LLM is ever in the
verification path.

## [0.2.0] — 2026-06-28

The first release since the project's initial 0.1.x line. Eight PRs worth of changes, each validated by
the project's own dogfood CI action on its own diff. Tests grew from 54 → 152; the seed bench stayed at
20 cases with FP=0, FN=0 throughout. No breaking changes to existing APIs; new exports and subcommands
are additive.

### Added — features

- **`tribunal propose` subcommand** ([#3](https://github.com/eviano/tribunal/pull/3)) — an LLM-*proposer*
  that turns a diff into a ```` ```tribunal ```` claims block for the deterministic `check` to adjudicate.
  Activates the previously-dormant claim-reconciliation "moat" (no agent emits the claims convention
  today). Pluggable OpenAI-compatible provider (fetch, no SDK), two-step flow (`propose` never runs
  verifiers), full-diff-in-prompt behind a mandatory send-guard (`--allow-send-diff`). The LLM can never
  manufacture a `CONTRADICTED` — unknown claim keys degrade to `UNVERIFIED`. Honors SPEC §3.1.
- **`risky-diff-no-test` analyzer** ([#2](https://github.com/eviano/tribunal/pull/2)) — a claim-independent
  *signal* analyzer (SPEC §3.7, "silence is not an escape hatch"). Flags a diff touching a
  security-relevant area (auth, crypto, payments, `token`, …) with no correlated asserting test.
  **Never emits `CONTRADICTED`** — risk is semantic, so it's PASS/UNVERIFIED only. Tokenizes whole tokens
  (not substrings), so `authors.ts`/`tokenize.ts` are correctly not flagged.
- **`comment-code-drift` analyzer** ([#7](https://github.com/eviano/tribunal/pull/7)) — the last spec'd
  analyzer (SPEC §5a). Flags a comment/docstring referencing a symbol whose definition changed in the
  diff, where the comment wasn't freshly added. Cross-file (same-file + other changed files). Also a
  **signal analyzer** (UNVERIFIED-only). Completes the §5a analyzer set.
- **SARIF output** ([#4](https://github.com/eviano/tribunal/pull/4)) — `--format sarif` emits a SARIF
  Log v2.1.0 for GitHub code-scanning alerts. Level mapping: CONTRADICTED→error, UNVERIFIED→note,
  PASS→omitted. Stable `partialFingerprints` (from analyzer+file+line+claim, not prose). Bring-your-own
  `upload-sarif`; the bundled action is unchanged (minimal permissions).
- **`tribunal.yml` config** ([#6](https://github.com/eviano/tribunal/pull/6)) — per-analyzer
  enable/disable + extra generated-path patterns. Extend-defaults semantics (config can only *add*
  coverage, never drop a safety net). Zero-dep YAML-subset parser (no `js-yaml`). Fail-loud on
  malformed config / unknown analyzer ids / unknown keys. Absent file ≡ all defaults.

### Added — docs

- **CONTRIBUTING.md** ([#8](https://github.com/eviano/tribunal/pull/8)) — the Trust Contract as the
  governing rule, the dev loop, how to add an analyzer (including the signal-vs-gate verdict-semantics
  decision), and bench-case guidance.
- **SECURITY.md** ([#8](https://github.com/eviano/tribunal/pull/8)) — threat model (no false
  `CONTRADICTED`; no LLM in the verdict path; determinism), the `propose` LLM boundary, private reporting
  guidance, and what is *not* a security issue.

### Changed

- **`no-public-api-change` now aggregates the exported-symbol set** across changed files
  ([#1](https://github.com/eviano/tribunal/pull/1)) instead of diffing per-file. A refactor that moves
  `export const foo` between two changed files is no longer a false `CONTRADICTED`. Unchanged files cancel
  out of the diff, so aggregation is sound and bounded. A net change is only `CONTRADICTED` when no
  changed module is non-enumerable.
- **`risky-diff-no-test` skips generated/build-output paths** ([#5](https://github.com/eviano/tribunal/pull/5))
  by default (`dist/`, `action-dist/`, `*.min.js`, …). A bundled artifact carrying the project's own risky
  vocab is no longer a false-ish 🟡. Override with `--no-skip-generated` / `TRIBUNAL_NO_SKIP_GENERATED`.

### Fixed

- **`parseUnifiedDiff` no longer silently drops plain unified diffs** ([#1](https://github.com/eviano/tribunal/pull/1)).
  A `--- /+++ ` patch (from `diff -u`, a `git format-patch` body, or a hand-written `--diff` file)
  previously parsed to `[]` and reported "No issues found ✅" on a patch it never read. Now opens a file
  record on a bare `---` header; git-style behavior unchanged.
- **Node.js built-ins are no longer flagged** ([#8](https://github.com/eviano/tribunal/pull/8)).
  `hallucinated-symbol` was firing `🟡 Unresolved package import` on `node:fs`/`node:crypto`/`node:path`
  (and the bare form) whenever the target repo had no resolvable `node_modules` on the runner. Now skipped;
  genuine missing packages are still flagged.

## [0.1.2] — initial published line

See git history for the 0.1.x baseline.

[0.2.0]: https://github.com/eviano/tribunal/releases/tag/v0.2.0
[0.1.2]: https://github.com/eviano/tribunal/releases/tag/v0.1.2
