import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** US dollars per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * First-party API list prices, for an estimate on the metrics page and the
 * daily budget — not for billing. The provider's invoice is the truth; check
 * the pricing page when adding a model. Cache writes on the default
 * five-minute TTL cost 1.25x the input price.
 */
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  demo: { input: 0, output: 0, cacheRead: 0 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Estimated cost of one model turn, or null for a model with no listed price.
 * Takes the model the API says served the turn, which a refusal fallback can
 * make different from the one requested.
 */
export function turnCost(model: string, usage: BetaUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.input_tokens * perToken(price.input) +
    usage.output_tokens * perToken(price.output) +
    (usage.cache_read_input_tokens ?? 0) * perToken(price.cacheRead) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(price.input * CACHE_WRITE_MULTIPLIER)
  );
}
