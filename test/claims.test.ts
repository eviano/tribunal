import { describe, it, expect } from 'vitest';
import { parseClaims } from '../src/claims';

describe('parseClaims', () => {
  it('extracts only the fenced tribunal block when present', () => {
    const body = `Some PR description prose that mentions tests and api.

\`\`\`tribunal
added-test
no-public-api-change
\`\`\`

More prose down here.`;
    const claims = parseClaims(body);
    expect(claims.map((c) => c.key)).toEqual(['added-test', 'no-public-api-change']);
  });

  it('returns nothing for a fence-less PR body when requireFence is set', () => {
    expect(parseClaims('just prose, no claims here', { requireFence: true })).toEqual([]);
  });

  it('parses a whole claims file when there is no fence', () => {
    const file = `# my claims
added-test
no-default-flip: timeoutMs`;
    const claims = parseClaims(file);
    expect(claims).toHaveLength(2);
    expect(claims[1]).toMatchObject({ key: 'no-default-flip', arg: 'timeoutMs' });
  });

  it('normalizes keys (case, spaces, underscores) and strips list markers', () => {
    const file = `- Added Test
* No_Public_API_Change`;
    expect(parseClaims(file).map((c) => c.key)).toEqual(['added-test', 'no-public-api-change']);
  });

  it('ignores blank and comment lines', () => {
    const file = `
# comment
// also comment
added-test
`;
    expect(parseClaims(file).map((c) => c.key)).toEqual(['added-test']);
  });
});
