import type { Analyzer } from '../types.js';
import { assertionFreeTest } from './assertionFreeTest.js';

/**
 * The analyzer registry. New analyzers (hallucinated-symbol, comment-code-drift, claim-reconciliation)
 * are added here as they land. Order is display-only; analyzers are independent and side-effect free.
 */
export const analyzers: Analyzer[] = [assertionFreeTest];

export { assertionFreeTest };
