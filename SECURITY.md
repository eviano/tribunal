# Security Policy

## Threat model

Tribunal is a CI gate that flips builds red. Its security-relevant properties, in priority order:

1. **No false `CONTRADICTED`.** A false red blocks legitimate work, so `CONTRADICTED` is constrained to
   *syntactic certainties* (Trust Contract §3.4). Semantic judgements degrade to `UNVERIFIED`, which
   never blocks. The false-positive budget is ~0 and is measured by the seed corpus (`bench/`).
2. **No LLM in the verification path.** `tribunal propose` may *suggest* claims, but deterministic code
   *adjudicates* them. An unknown/hallucinated/injected claim key degrades to `UNVERIFIED` — a model
   cannot manufacture a `CONTRADICTED`. See [`docs/SPEC.md`](docs/SPEC.md) §3.1.
3. **Determinism.** Analyzers read the repo's own files and `tsconfig`; no network in the verdict path.
   The GitHub Action runs a prebuilt, self-contained bundle with no runtime install.

## The LLM boundary (`tribunal propose`)

`propose` is the only subcommand that contacts an external service, and it is **off by default**:

- It refuses to send the diff unless `--allow-send-diff` (or `TRIBUNAL_ALLOW_SEND_DIFF=1`) is set — the
  diff is source code, and sending it is an outward publish. Without the flag it prints the prompt and
  sends nothing.
- Its output is a `claims` block consumed by the *separate* `check` command. `propose` imports no
  verifier and never calls `exitCode`. Even a fully malicious model response cannot produce a blocking
  `CONTRADICTED` — unknown keys degrade to `UNVERIFIED` in the deterministic verifier registry.

If you find a way for `propose` output to influence `exitCode` directly, that is a security issue.

## Reporting a vulnerability

Please report security issues **privately** rather than as a public issue. Open a GitHub Security
Advisory on this repository (Security → Advisories → "Report a vulnerability"), or email the maintainer
directly if you prefer.

Please include:

- A description of the impact, especially any path to a **false `CONTRADICTED`** (the highest-priority
  class) or any way for an LLM/proposer output to reach `exitCode`.
- A minimal reproduction (a diff + the command + the verdict it produced).
- The analyzer(s) involved, if known.

We'll acknowledge within a reasonable window and coordinate a fix + disclosure.

## What is *not* a security issue

- A 🟡 `UNVERIFIED` finding you believe is noise — that's a precision bug, not a security
  vulnerability. File a regular issue/PR (signal analyzers are allowed to be noisy; only `CONTRADICTED`
  precision is security-relevant).
- `hallucinated-symbol` flagging a genuinely unresolvable package as `UNVERIFIED` — that's the
  intended behavior (dependency existence is out of scope for this check).
- A real `CONTRADICTED` on a diff that genuinely violates a syntactic invariant — that's the tool
  working correctly.
