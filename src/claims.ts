import type { Claim } from './types.js';

const FENCE_RE = /```tribunal[^\n]*\n([\s\S]*?)```/i;

export interface ParseClaimsOptions {
  /**
   * When true, claims are ONLY read from a ```tribunal fenced block. Use this for free-text sources
   * like a PR body, where treating every prose line as a claim would be wrong. When false (a dedicated
   * claims file), the whole text is parsed, but a fenced block still takes precedence if present.
   */
  requireFence?: boolean;
}

/**
 * Extract machine-readable claims. This is deliberately a parser, not natural-language understanding:
 * an agent (or human) declares claims in a fixed vocabulary, so an unparsed line can never become a
 * false CONTRADICTED — it simply isn't a claim.
 */
export function parseClaims(text: string, opts: ParseClaimsOptions = {}): Claim[] {
  if (!text) return [];
  const fenced = text.match(FENCE_RE);
  if (opts.requireFence && !fenced) return [];
  const body = fenced ? fenced[1] : text;

  const claims: Claim[] = [];
  for (const rawLine of body.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    line = line.replace(/^[-*]\s+/, '').trim(); // strip markdown list markers
    if (!line) continue;

    const idx = line.indexOf(':');
    const keyPart = idx >= 0 ? line.slice(0, idx) : line;
    const arg = idx >= 0 ? line.slice(idx + 1).trim() : undefined;
    const key = keyPart.trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (!key) continue;
    claims.push({ key, arg: arg || undefined, raw: line });
  }
  return claims;
}
