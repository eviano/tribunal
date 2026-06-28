import type { Analyzer } from '../types.js';
import { assertionFreeTest } from './assertionFreeTest.js';
import { hallucinatedSymbol } from './hallucinatedSymbol.js';
import { claimReconciliation } from './claimReconciliation.js';
import { riskyDiffNoTest } from './riskyDiffNoTest.js';

/**
 * The analyzer registry. Analyzers are independent and side-effect free; order is display-only.
 * `riskyDiffNoTest` is UNVERIFIED-only (never CONTRADICTED) — it is a signal analyzer, never a gate.
 */
export const analyzers: Analyzer[] = [
  assertionFreeTest,
  hallucinatedSymbol,
  riskyDiffNoTest,
  claimReconciliation,
];

export { assertionFreeTest, hallucinatedSymbol, riskyDiffNoTest, claimReconciliation };
