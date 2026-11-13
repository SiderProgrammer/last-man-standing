import { spokeRpcUrls } from '../csp.js';

/** What the dev burner's chain choice reads: the RPCs the dev build was given. */
export interface BurnerRpcs {
  VITE_RPC_URL?: string;
  VITE_SPOKE_RPC_URL?: string;
  VITE_SPOKE_RPC_URLS?: string;
}

/**
 * The node the dev burner signs through, from the page's `?chain=`.
 * No `chain` (or `hub`) is the hub; `spoke` is the first spoke; anything
 * else is a key of `VITE_SPOKE_RPC_URLS`: a chain id or an alias such as
 * `op`. A chain this build has no RPC for throws instead of falling back to
 * the hub, which would put the player on the wrong chain without a word.
 */
export function burnerRpcFor(chain: string | null, env: BurnerRpcs): string | undefined {
  if (!chain || chain === 'hub') return env.VITE_RPC_URL;
  const spokes = spokeRpcUrls(env.VITE_SPOKE_RPC_URLS);
  if (chain === 'spoke') {
    const url = env.VITE_SPOKE_RPC_URL || Object.values(spokes)[0];
    if (url) return url;
  } else if (spokes[chain]) {
    return spokes[chain];
  }
  const known = ['hub', ...(env.VITE_SPOKE_RPC_URL || Object.keys(spokes).length ? ['spoke'] : []), ...Object.keys(spokes)];
  throw new Error(`This build has no chain "${chain}" for ?chain=. Use one of: ${known.join(', ')}.`);
}
