import type { Usage } from './model.js';

/** US dollars per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Gemini API list prices, paid tier, prompts up to 200k tokens; output
 * includes thinking. For an estimate on the metrics page and the daily
 * budget — not for billing. The provider's invoice is the truth; check the
 * pricing page when adding a model. The 3.6+ Flash and 4 Argon rates are
 * introductory and rise after 2026.
 */
const PRICES: Record<string, Price> = {
  'gemini-4-argon': { input: 2, output: 10, cacheRead: 0.1 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  demo: { input: 0, output: 0, cacheRead: 0 },
};

/** Estimated cost of one model turn, or null for a model with no listed price. */
export function turnCost(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.input_tokens * perToken(price.input) +
    usage.output_tokens * perToken(price.output) +
    usage.cache_read_input_tokens * perToken(price.cacheRead)
  );
}
