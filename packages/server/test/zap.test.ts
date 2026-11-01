import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZERO_ADDRESS } from '@lms/consensus';
import { loadConfig, parseZapTokens, zapInfo } from '@lms/server';

const USDC = `0x${'0c'.repeat(20)}` as const;
const DAI = `0x${'0d'.repeat(20)}` as const;
const ZAP = `0x${'2a'.repeat(20)}` as const;
const QUOTER = `0x${'3b'.repeat(20)}` as const;

const usdcEntry = {
  symbol: 'USDC',
  address: USDC,
  decimals: 6,
  path: [{ intermediateCurrency: USDC, fee: 500, tickSpacing: 10 }],
};

describe('ZAP_TOKENS', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is empty when unset', () => {
    expect(parseZapTokens('')).toEqual([]);
    expect(parseZapTokens('   ')).toEqual([]);
  });

  it('parses a token and defaults the route to no hooks', () => {
    expect(parseZapTokens(JSON.stringify([usdcEntry]))).toEqual([
      {
        symbol: 'USDC',
        address: USDC,
        decimals: 6,
        path: [
          { intermediateCurrency: USDC, fee: 500, tickSpacing: 10, hooks: ZERO_ADDRESS, hookData: '0x' },
        ],
      },
    ]);
  });

  it('keeps a multi-hop route in order', () => {
    const dai = {
      symbol: 'DAI',
      address: DAI,
      decimals: 18,
      path: [
        { intermediateCurrency: DAI, fee: 100, tickSpacing: 1 },
        { intermediateCurrency: USDC, fee: 500, tickSpacing: 10 },
      ],
    };
    const [parsed] = parseZapTokens(JSON.stringify([dai]));
    expect(parsed?.path.map((hop) => hop.intermediateCurrency)).toEqual([DAI, USDC]);
  });

  it('drops a route that does not start at the token being paid', () => {
    // The contract charges `path[0]`, so this would take DAI from a player who picked USDC.
    const wrong = { ...usdcEntry, path: [{ intermediateCurrency: DAI, fee: 500, tickSpacing: 10 }] };
    expect(parseZapTokens(JSON.stringify([wrong, usdcEntry]))).toHaveLength(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it('drops malformed entries and keeps the rest', () => {
    const bad = [
      { ...usdcEntry, address: 'oops' },
      { ...usdcEntry, address: ZERO_ADDRESS },
      { ...usdcEntry, decimals: 6.5 },
      { ...usdcEntry, symbol: '' },
      { ...usdcEntry, path: [] },
      { ...usdcEntry, path: [{ intermediateCurrency: USDC, fee: -1, tickSpacing: 10 }] },
      { ...usdcEntry, path: [{ intermediateCurrency: USDC, fee: 500, tickSpacing: 0 }] },
      { ...usdcEntry, path: [{ intermediateCurrency: USDC, fee: 500, tickSpacing: 10, hookData: 'zz' }] },
      null,
    ];
    expect(parseZapTokens(JSON.stringify([...bad, usdcEntry]))).toHaveLength(1);
  });

  it('is empty, not fatal, on invalid JSON', () => {
    expect(parseZapTokens('[{')).toEqual([]);
    expect(parseZapTokens('{"symbol":"USDC"}')).toEqual([]);
  });
});

describe('zap offer', () => {
  const tokens = parseZapTokens(JSON.stringify([usdcEntry]));

  it('is offered with a zap, a quoter and at least one token', () => {
    expect(zapInfo(ZAP, QUOTER, tokens)).toEqual({ address: ZAP, quoter: QUOTER, tokens });
  });

  it('is withheld when any part is missing', () => {
    expect(zapInfo(ZERO_ADDRESS, QUOTER, tokens)).toBeNull();
    expect(zapInfo(ZAP, ZERO_ADDRESS, tokens)).toBeNull();
    expect(zapInfo(ZAP, QUOTER, [])).toBeNull();
  });

  it('is off by default', () => {
    const config = loadConfig({});
    expect(zapInfo(config.zapJoin, config.v4Quoter, parseZapTokens(config.zapTokens))).toBeNull();
  });
});
