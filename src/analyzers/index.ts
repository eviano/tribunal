import type { Analyzer } from '../types.js';
import { assertionFreeTest } from './assertionFreeTest.js';
import { hallucinatedSymbol } from './hallucinatedSymbol.js';

/**
 * The analyzer registry. New analyzers (comment-code-drift, claim-reconciliation) are added here as
 * they land. Order is display-only; analyzers are independent and side-effect free.
 */
export const analyzers: Analyzer[] = [assertionFreeTest, hallucinatedSymbol];

export { assertionFreeTest, hallucinatedSymbol };
