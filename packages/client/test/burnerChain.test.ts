import { describe, expect, it } from 'vitest';
import { burnerRpcFor } from '../src/wallet/burnerChain.js';

const env = {
  VITE_RPC_URL: 'http://hub',
  VITE_SPOKE_RPC_URL: 'http://arb',
  VITE_SPOKE_RPC_URLS: JSON.stringify({ 42161: 'http://arb', arb: 'http://arb', 10: 'http://op', op: 'http://op' }),
};

describe('the dev burner chain', () => {
  it('is the hub with no ?chain=, or ?chain=hub', () => {
    expect(burnerRpcFor(null, env)).toBe('http://hub');
    expect(burnerRpcFor('hub', env)).toBe('http://hub');
  });

  it('takes a spoke by alias, by chain id, or as the first spoke', () => {
    expect(burnerRpcFor('op', env)).toBe('http://op');
    expect(burnerRpcFor('10', env)).toBe('http://op');
    expect(burnerRpcFor('spoke', env)).toBe('http://arb');
    expect(burnerRpcFor('spoke', { VITE_RPC_URL: 'http://hub', VITE_SPOKE_RPC_URLS: JSON.stringify({ 10: 'http://op' }) })).toBe('http://op');
  });

  it('refuses a chain it has no RPC for, instead of signing on the hub', () => {
    expect(() => burnerRpcFor('eth', env)).toThrow(/no chain "eth"/);
    try {
      burnerRpcFor('eth', env);
    } catch (error) {
      for (const chain of ['hub', 'spoke', '42161', 'arb', '10', 'op']) expect((error as Error).message).toContain(chain);
    }
    expect(() => burnerRpcFor('spoke', { VITE_RPC_URL: 'http://hub' })).toThrow(/Use one of: hub\./);
  });
});
