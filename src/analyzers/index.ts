import type { Analyzer } from '../types.js';
import { assertionFreeTest } from './assertionFreeTest.js';
import { hallucinatedSymbol } from './hallucinatedSymbol.js';
import { claimReconciliation } from './claimReconciliation.js';

/**
 * The analyzer registry. Analyzers are independent and side-effect free; order is display-only.
 */
export const analyzers: Analyzer[] = [assertionFreeTest, hallucinatedSymbol, claimReconciliation];

export { assertionFreeTest, hallucinatedSymbol, claimReconciliation };
