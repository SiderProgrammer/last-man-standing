import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  PRACTICE_CHAIN_ID,
  chainCss,
  chainIdForEid,
  chainInfo,
  eidForChainId,
  normaliseOriginChainId,
} from '../src/chains.js';

const HUB = 11155111;

describe('chainInfo', () => {
  it('names a known chain', () => {
    expect(chainInfo(8453).name).toBe('Base');
    expect(chainInfo(8453).short).toBe('BASE');
  });

  it('falls back to the numeric id so an unlisted spoke still renders', () => {
    const info = chainInfo(123_456);
    expect(info.chainId).toBe(123_456);
    expect(info.short).toBe('123456');
    expect(info.name).toBe('Chain 123456');
  });

  it('labels practice seats rather than showing chain 0', () => {
    expect(chainInfo(PRACTICE_CHAIN_ID).name).toBe('Practice');
  });
});

describe('normaliseOriginChainId', () => {
  it('maps a zero origin to the hub, because that is what the escrow stores for a local stake', () => {
    expect(normaliseOriginChainId(0, HUB)).toBe(HUB);
  });

  it('maps a transport endpoint id back to its chain id', () => {
    // 40245 is Base Sepolia's LayerZero endpoint id, not a chain id: rendering
    // it verbatim would label the seat "chain 40245".
    expect(normaliseOriginChainId(40_245, HUB)).toBe(84_532);
    expect(normaliseOriginChainId(30_110, HUB)).toBe(42_161);
  });

  it('passes an unrecognised origin through unchanged', () => {
    // A transport whose id space already is chain ids stays correct, and an
    // unknown endpoint degrades to a number instead of to the wrong chain.
    expect(normaliseOriginChainId(84_532, HUB)).toBe(84_532);
    expect(normaliseOriginChainId(999_999, HUB)).toBe(999_999);
  });
});

describe('the chain table', () => {
  it('has no duplicate chain ids or endpoint ids', () => {
    const chainIds = CHAINS.map((chain) => chain.chainId);
    const eids = CHAINS.flatMap((chain) => (chain.eid === undefined ? [] : [chain.eid]));
    expect(new Set(chainIds).size).toBe(chainIds.length);
    expect(new Set(eids).size).toBe(eids.length);
  });

  it('round-trips every endpoint id', () => {
    for (const chain of CHAINS) {
      if (chain.eid === undefined) continue;
      expect(chainIdForEid(chain.eid)).toBe(chain.chainId);
      expect(eidForChainId(chain.chainId)).toBe(chain.eid);
    }
  });

  it('renders every colour as a six-digit hex string', () => {
    for (const chain of CHAINS) {
      expect(chainCss(chain.color)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
