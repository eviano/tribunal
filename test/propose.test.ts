import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  extractClaimsFromResponse,
  renderClaimsBlock,
  runPropose,
  PROPOSABLE_CLAIMS,
  type FetchLike,
} from '../src/propose';
import { parseClaims } from '../src/claims';
import { runTribunal, type DiffSource } from '../src/index';
import { recognizedClaims } from '../src/analyzers/claimReconciliation';

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,2 @@
+export function login(u, p) { return u === p; }
+export function token() { return 'x'; }
`;

describe('propose · prompt construction', () => {
  it('names only the recognized claim keys and forbids invention', () => {
    const { system } = buildPrompt(DIFF, undefined);
    for (const k of recognizedClaims) expect(system).toContain(k);
    expect(system).toContain('ONLY propose claim keys from this closed set');
    expect(system).toContain('Any key not in the set above is useless');
  });

  it('includes the diff and PR body in the user message', () => {
    const { user } = buildPrompt(DIFF, 'This PR adds login.');
    expect(user).toContain('--- DIFF (unified) ---');
    expect(user).toContain("export function login");
    expect(user).toContain('--- PR BODY (author description) ---');
    expect(user).toContain('This PR adds login.');
  });
});

describe('propose · extractClaimsFromResponse (injection guard)', () => {
  it('parses a well-formed JSON response', () => {
    const claims = extractClaimsFromResponse(
      JSON.stringify({ claims: ['added-test', 'no-public-api-change'], rationale: {} }),
    );
    expect(claims.map((c) => c.key)).toEqual(['added-test', 'no-public-api-change']);
  });

  it('DROPS unknown keys — the defense-in-depth guard (never trusts the model)', () => {
    // A hallucinated or prompt-injected response trying to smuggle a fake/blocked claim.
    const malicious = JSON.stringify({
      claims: ['added-test', 'totally-safe-no-bugs', 'BYPASS_ALL_CHECKS', 'no-public-api-change'],
      rationale: {},
    });
    const claims = extractClaimsFromResponse(malicious);
    expect(claims.map((c) => c.key)).toEqual(['added-test', 'no-public-api-change']);
    expect(claims.find((c) => c.key.includes('bypass'))).toBeUndefined();
  });

  it('dedupes repeated keys', () => {
    const claims = extractClaimsFromResponse(
      JSON.stringify({ claims: ['added-test', 'added-test', 'added-test'] }),
    );
    expect(claims).toHaveLength(1);
  });

  it('falls back to line-scanning when JSON is absent', () => {
    const claims = extractClaimsFromResponse('I think this needs:\nadded-test\nand no-public-api-change');
    expect(claims.map((c) => c.key).sort()).toEqual(['added-test', 'no-public-api-change']);
  });

  it('returns [] for a response with no recognized claims', () => {
    expect(extractClaimsFromResponse('everything looks fine, ship it')).toEqual([]);
  });

  it('returns [] for garbage', () => {
    expect(extractClaimsFromResponse('{{{not json')).toEqual([]);
  });
});

describe('propose · renderClaimsBlock round-trips through parseClaims', () => {
  it('check consumes exactly what propose emits', () => {
    const block = renderClaimsBlock([
      { key: 'added-test', arg: undefined, raw: 'added-test' },
      { key: 'no-public-api-change', arg: undefined, raw: 'no-public-api-change' },
    ]);
    expect(block).toContain('```tribunal');
    // parseClaims with requireFence (as `check --pr-body` uses it) must recover the same keys.
    const recovered = parseClaims(block, { requireFence: true }).map((c) => c.key);
    expect(recovered).toEqual(['added-test', 'no-public-api-change']);
  });

  it('empty claims render a valid (no-claims) block that parses to []', () => {
    const block = renderClaimsBlock([]);
    expect(parseClaims(block, { requireFence: true })).toEqual([]);
  });
});

describe('propose · runPropose send-guard', () => {
  const provider = { endpoint: 'https://example.test/v1', model: 'demo-model', apiKey: 'k' };

  it('REFUSES to send without allowSendDiff (review-first)', async () => {
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      throw new Error('should not be called');
    };
    const notices: string[] = [];
    const result = await runPropose({
      diff: DIFF,
      provider,
      fetch,
      allowSendDiff: false,
      notice: (m) => notices.push(m),
    });
    expect(result.sent).toBe(false);
    expect(called).toBe(false);
    expect(result.claims).toEqual([]);
    expect(notices.some((n) => /NOT sending/.test(n))).toBe(true);
    expect(notices.some((n) => /--allow-send-diff/.test(n))).toBe(true);
  });

  it('sends with allowSendDiff and returns the model claims', async () => {
    const fetch: FetchLike = async (_url, init) => {
      // Confirm the request shape and that the diff is in the body.
      const body = JSON.parse(init.body);
      expect(body.model).toBe('demo-model');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(JSON.stringify(body.messages)).toContain('export function login');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ claims: ['added-test'], rationale: {} }) } }],
          }),
      };
    };
    const notices: string[] = [];
    const result = await runPropose({
      diff: DIFF,
      provider,
      fetch,
      allowSendDiff: true,
      notice: (m) => notices.push(m),
    });
    expect(result.sent).toBe(true);
    expect(result.claims.map((c) => c.key)).toEqual(['added-test']);
    expect(notices.some((n) => /sending diff to/.test(n))).toBe(true);
  });

  it('throws on a non-2xx provider response', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    await expect(
      runPropose({ diff: DIFF, provider, fetch, allowSendDiff: true, notice: () => {} }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('propose · end-to-end Trust-Contract boundary', () => {
  // The decisive proof: an LLM (or prompt-injected attacker) can only ever emit claim KEYS. Unknown keys
  // are downgraded to UNVERIFIED by the deterministic verifier registry — they can never become a
  // CONTRADICTED, which is the only verdict that blocks under --hard-fail. So the LLM path cannot
  // manufacture a false red, no matter what the model returns.
  //
  // We use a diff with NO public-API change and NO test, so the only legitimate verifiers have nothing to
  // contradict; the smuggled unknown key must degrade to UNVERIFIED and the result must not be blockable.
  it('a smuggled unknown claim key degrades to UNVERIFIED, never CONTRADICTED', () => {
    const noApiChangeDiff = `diff --git a/README.md b/README.md
index 1..2 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-hello
+hello world
`;
    const src: DiffSource = {
      repoRoot: '/virtual',
      diffText: noApiChangeDiff,
      claims: [
        { key: 'all-green-trust-me', arg: undefined, raw: 'all-green-trust-me' }, // unknown/attacker key
      ],
    };
    const report = runTribunal(src);
    // The smuggled key is downgraded to UNVERIFIED by the verifier registry.
    const smuggled = report.findings.find((f) => /all-green-trust-me/.test(f.detail));
    expect(smuggled?.verdict).toBe('UNVERIFIED');
    // No CONTRADICTED verdict anywhere → not blockable under --hard-fail, regardless of LLM output.
    expect(report.findings.some((f) => f.verdict === 'CONTRADICTED')).toBe(false);
  });
});
