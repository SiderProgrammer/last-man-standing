import {
  ZERO_ADDRESS,
  errorMessage,
  sameAddress,
  type ZapInfo,
  type ZapPathKey,
  type ZapToken,
} from '@lms/protocol';
import { log } from '../observability/log.js';

const logger = log.child({ component: 'zap' });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

/**
 * Parses `ZAP_TOKENS`: the tokens players may pay with, each with its v4 route
 * to ETH.
 *
 * `[{"symbol":"USDC","address":"0x…","decimals":6,
 *    "path":[{"intermediateCurrency":"0x…","fee":500,"tickSpacing":10}]}]`
 *
 * `hooks` and `hookData` default to none. Soft on bad input, like
 * `AVATAR_COLLECTIONS`: a malformed entry is dropped with a warning rather than
 * stopping the server, because token payment is an extra and ETH still works.
 * An entry is malformed when its route does not start at the token itself —
 * the contract would charge a different token than the one the player picked.
 */
export function parseZapTokens(raw: string): ZapToken[] {
  if (raw.trim().length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');

    return parsed.flatMap((item): ZapToken[] => {
      const token = toToken(item);
      if (!token) logger.warn('ignoring malformed token', { entry: JSON.stringify(item) });
      return token ? [token] : [];
    });
  } catch (error) {
    logger.warn('ZAP_TOKENS is not valid JSON', { error: errorMessage(error) });
    return [];
  }
}

/**
 * What `hello` advertises, or null when token payment is not on offer.
 *
 * All three parts or nothing: a zap with no quoter cannot tell the player what
 * they will pay, and one with no tokens has nothing to offer.
 */
export function zapInfo(
  address: `0x${string}`,
  quoter: `0x${string}`,
  tokens: readonly ZapToken[],
): ZapInfo | null {
  if (address === ZERO_ADDRESS || quoter === ZERO_ADDRESS || tokens.length === 0) return null;
  return { address, quoter, tokens: [...tokens] };
}

function toToken(item: unknown): ZapToken | null {
  if (typeof item !== 'object' || item === null) return null;
  const { symbol, address, decimals, path } = item as Record<string, unknown>;

  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  if (typeof address !== 'string' || !ADDRESS.test(address) || address === ZERO_ADDRESS) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  if (!Array.isArray(path) || path.length === 0) return null;

  const hops = path.map(toHop);
  if (hops.some((hop) => hop === null)) return null;
  const route = hops as ZapPathKey[];
  if (!sameAddress(route[0]?.intermediateCurrency, address)) return null;

  return { symbol, address: address as `0x${string}`, decimals, path: route };
}

function toHop(item: unknown): ZapPathKey | null {
  if (typeof item !== 'object' || item === null) return null;
  const { intermediateCurrency, fee, tickSpacing, hooks = ZERO_ADDRESS, hookData = '0x' } =
    item as Record<string, unknown>;

  if (typeof intermediateCurrency !== 'string' || !ADDRESS.test(intermediateCurrency)) return null;
  if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0 || fee > 0xffffff) return null;
  if (
    typeof tickSpacing !== 'number' ||
    !Number.isInteger(tickSpacing) ||
    tickSpacing < 1 ||
    tickSpacing > 0x7fffff
  ) {
    return null;
  }
  if (typeof hooks !== 'string' || !ADDRESS.test(hooks)) return null;
  if (typeof hookData !== 'string' || !HEX.test(hookData)) return null;

  return {
    intermediateCurrency: intermediateCurrency as `0x${string}`,
    fee,
    tickSpacing,
    hooks: hooks as `0x${string}`,
    hookData: hookData as `0x${string}`,
  };
}
