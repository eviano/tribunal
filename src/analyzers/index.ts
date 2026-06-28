import type { Analyzer } from '../types.js';
import { assertionFreeTest } from './assertionFreeTest.js';
import { hallucinatedSymbol } from './hallucinatedSymbol.js';
import { claimReconciliation } from './claimReconciliation.js';
import { riskyDiffNoTest } from './riskyDiffNoTest.js';
import { commentCodeDrift } from './commentCodeDrift.js';

/**
 * The analyzer registry. Analyzers are independent and side-effect free; order is display-only.
 * `riskyDiffNoTest` and `commentCodeDrift` are UNVERIFIED-only (never CONTRADICTED) — they are signal
 * analyzers, never a gate.
 */
export const analyzers: Analyzer[] = [
  assertionFreeTest,
  hallucinatedSymbol,
  riskyDiffNoTest,
  commentCodeDrift,
  claimReconciliation,
];

export { assertionFreeTest, hallucinatedSymbol, riskyDiffNoTest, commentCodeDrift, claimReconciliation };
