/**
 * `tribunal propose` — an LLM-*proposer* that turns a diff (and optional PR body) into a
 * ```tribunal claims block of CANDIDATE claims, for the existing deterministic `tribunal check` to
 * adjudicate.
 *
 * ── The Trust-Contract boundary (SPEC §1): a model may PROPOSE a claim to check; a model may never
 *    ADJUDICATE. This module honors that with two guarantees:
 *
 *   1. SEPARATION: nothing here imports or calls `runAnalyzers`, `runTribunal`, `exitCode`, or any
 *      verifier. `propose` only reads a diff and writes a claims block. The verdict path is untouched.
 *   2. DEFENSE-IN-DEPTH: even if the model hallucinates a key or is prompt-injected, the *existing*
 *      `claimReconciliation` verifier map degrades every unrecognized key to 🟡 UNVERIFIED (never 🔴).
 *      So the worst a malicious LLM can do is emit noise that the deterministic checker labels yellow.
 *      It cannot flip a build red. We additionally constrain the prompt to the recognized set and
 *      validate the response, but those are convenience, not the safety boundary — the boundary is
 *      architectural.
 *
 * ── The send-guard: the full diff is source code, and sending it to an external LLM endpoint is an
 *    outward-facing publish. `propose` refuses to send unless the caller opts in with `allowSendDiff`.
 *    Without it, the prompt is printed for review and nothing leaves the machine.
 */

import type { Claim } from './types.js';
import { recognizedClaims } from './analyzers/claimReconciliation.js';

/** The closed claim vocabulary the model is allowed to propose from, deduped & sorted for the prompt. */
export const PROPOSABLE_CLAIMS: readonly string[] = Array.from(new Set(recognizedClaims)).sort();

/**
 * Build the { system, user } prompt for the proposer. Pure & deterministic — no I/O. The prompt:
 *   - tells the model the ONLY keys it may emit (the recognized set),
 *   - explains that any other output is useless (it degrades to UNVERIFIED in the checker),
 *   - asks for a JSON object so parsing is robust,
 *   - includes the full diff (per the chosen design) + any PR body as context.
 *
 * Note on the diff in the prompt: prompt-injection from diff content cannot escalate here, because the
 * model's output is never trusted (see module doc + `validateAndNormalize`). It can at worst produce a
 * claim key, which is either recognized (and then deterministically verified by `check`) or ignored.
 */
export function buildPrompt(
  diff: string,
  prBody: string | undefined,
  proposals: readonly string[] = PROPOSABLE_CLAIMS,
): { system: string; user: string } {
  const list = proposals.map((k) => `  - ${k}`).join('\n');
  const system = [
    'You are a strict claim-proposer for Tribunal, a deterministic PR-check tool.',
    'You PROPOSE candidate claims; you NEVER decide whether a claim holds. A separate deterministic',
    'engine will verify each claim. Your job is only to suggest which claims a reviewer should ask the',
    'engine to check, based on what the PR appears to do.',
    '',
    `You may ONLY propose claim keys from this closed set (emit nothing else):`,
    list,
    '',
    'Rules:',
    '- Output ONLY a JSON object: {"claims": ["<key>", ...], "rationale": {"<key>": "<short reason>"}}.',
    '- Use each key at most once. Use the exact spelling from the set above.',
    '- Propose ONLY claims plausibly relevant to the diff. An empty claims array is a valid answer.',
    '- Any key not in the set above is useless: it will be ignored by the engine. Do not invent keys.',
    '- Do not output markdown, fences, commentary, or any text outside the JSON object.',
  ].join('\n');

  const userParts: string[] = [];
  if (prBody && prBody.trim()) {
    userParts.push('--- PR BODY (author description) ---', prBody.trim(), '');
  }
  userParts.push('--- DIFF (unified) ---', diff || '(empty diff)');
  userParts.push(
    '',
    'Based on the above, output the JSON object of candidate claims. Remember: propose only from the',
    'closed set, and only if plausibly relevant.',
  );
  const user = userParts.join('\n');
  return { system, user };
}

/**
 * Parse a model response into candidate claims. Pure & fault-tolerant:
 *   1. Try JSON first (preferred). Accept {"claims": [...]}.
 *   2. Fall back to scanning for claim-key lines (covers endpoints without JSON mode).
 * Then VALIDATE every key against the recognized set — unknown keys are dropped, never trusted. This
 * is defense-in-depth: even a malicious/injected response cannot smuggle through an unrecognized key,
 * because the *checker* would label it UNVERIFIED anyway, and we drop it here for cleanliness.
 */
export function extractClaimsFromResponse(
  text: string,
  proposals: readonly string[] = PROPOSABLE_CLAIMS,
): Claim[] {
  const allowed = new Set(proposals);
  const keys: string[] = [];

  // 1) JSON object.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { claims?: unknown };
      if (Array.isArray(obj.claims)) {
        for (const c of obj.claims) {
          if (typeof c === 'string') keys.push(c);
        }
      }
    } catch {
      // fall through to line scan
    }
  }

  // 2) Fallback: tokenize the plain text on any run of chars that aren't [a-z0-9-], then keep only
  //    tokens that are exactly a recognized key. This handles endpoints without JSON mode that emit
  //    plain text like "added-test\nno-public-api-change". Only triggers if JSON parsing yielded
  //    nothing. Keys contain hyphens, so we tokenize on `[^a-z0-9-]+` (not whitespace→hyphen, which
  //    would merge keys into their neighbors and never match).
  if (keys.length === 0) {
    const tokenSet = new Set(text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
    for (const k of proposals) {
      if (tokenSet.has(k)) keys.push(k);
    }
  }

  // Validate + dedupe, preserving first-seen order.
  const seen = new Set<string>();
  const claims: Claim[] = [];
  for (const raw of keys) {
    const key = raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    claims.push({ key, arg: undefined, raw: key });
  }
  return claims;
}

/**
 * Render claims as a ```tribunal fenced block. This is the exact format `tribunal check --pr-body`
 * consumes, so `propose` → `check` is a clean round-trip:
 *
 *     tribunal propose --diff pr.diff --allow-send-diff --out claims.md
 *     tribunal check --diff pr.diff --pr-body claims.md
 *
 * The empty case uses a `#` comment (which `parseClaims` ignores) rather than a sentinel word, so an
 * empty block round-trips to zero claims instead of becoming a bogus claim.
 */
export function renderClaimsBlock(claims: readonly Claim[]): string {
  if (claims.length === 0) {
    return '```tribunal\n# (no claims proposed)\n```';
  }
  return '```tribunal\n' + claims.map((c) => c.key).join('\n') + '\n```';
}

/** An OpenAI-compatible chat-completions endpoint, abstracted for testability + provider choice. */
export interface ProposeProvider {
  endpoint: string;
  model: string;
  apiKey?: string;
}

/**
 * Fetch-like function signature. Matches the global `fetch`. Injected so tests never touch the network
 * and so the module stays deterministic.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface RunProposeOptions {
  diff: string;
  prBody?: string;
  provider: ProposeProvider;
  /** The fetch implementation to use (defaults to global fetch). Inject for tests. */
  fetch?: FetchLike;
  /** When false (default), the prompt is printed for review and NOTHING is sent. */
  allowSendDiff?: boolean;
  /** Sink for human-facing notices (warnings, send confirmations). Defaults to stderr. */
  notice?: (msg: string) => void;
}

export interface RunProposeResult {
  /** The ```tribunal claims block to feed to `tribunal check`. */
  block: string;
  /** The parsed claims (empty if the model proposed nothing valid). */
  claims: Claim[];
  /** True if the model was actually called; false if the send-guard withheld the request. */
  sent: boolean;
}

/**
 * Orchestrate a propose run. With `allowSendDiff` false (the default) this prints the prompt and returns
 * an empty claims block without contacting any endpoint — review-first. With it true, it calls the
 * OpenAI-compatible endpoint, parses the response, and renders the claims block.
 */
export async function runPropose(opts: RunProposeOptions): Promise<RunProposeResult> {
  const notice = opts.notice ?? ((m: string) => process.stderr.write(`${m}\n`));
  const { system, user } = buildPrompt(opts.diff, opts.prBody);

  if (!opts.allowSendDiff) {
    const lineCount = opts.diff ? opts.diff.split('\n').length : 0;
    const byteCount = Buffer.byteLength(`${system}\n\n${user}`, 'utf8');
    notice(
      `propose: send-guard active — NOT sending. Would send ${lineCount} diff lines / ${byteCount} bytes ` +
        `to ${opts.provider.endpoint} (${opts.provider.model}).`,
    );
    notice('propose: review the prompt above; rerun with --allow-send-diff to actually send.');
    // Print the full prompt to stdout for review (before the empty block).
    process.stdout.write(`${system}\n\n${user}\n`);
    return { block: renderClaimsBlock([]), claims: [], sent: false };
  }

  notice(`propose: sending diff to ${opts.provider.endpoint} (model: ${opts.provider.model}).`);
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchFn(`${opts.provider.endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.provider.apiKey ? { authorization: `Bearer ${opts.provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`propose: provider returned HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = JSON.parse(await res.text()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  const claims = extractClaimsFromResponse(content);
  return { block: renderClaimsBlock(claims), claims, sent: true };
}
