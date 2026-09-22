import { describe, expect, it } from 'vitest';
import { ZERO_ADDRESS } from '@lms/protocol';
import { loadConfig, relayerFrom, nullRelayer } from '@lms/server';

/**
 * Characterisation tests for configuration parsing.
 *
 * Several of these assert that something plainly wrong happens. That is the
 * point: `loadConfig` validates nothing, and these pin the current behaviour so
 * that fixing it is a deliberate, visible change rather than a silent one. Each
 * is cross-referenced from `docs/TODO.md` §3.4.
 */
describe('server configuration', () => {
  it('falls back to working defaults on an empty environment', () => {
    const config = loadConfig({});

    expect(config.port).toBe(8787);
    expect(config.chainId).toBe(11155111);
    expect(config.commitMs).toBe(20_000);
    expect(config.revealMs).toBe(12_000);
    expect(config.startingChips).toBe(1_000);
    expect(config.rpcUrl).toBe('');
    expect(config.escrow).toBe(ZERO_ADDRESS);
    expect(config.onChain).toBe(false);
  });

  it('reads the values it is given', () => {
    const config = loadConfig({ WS_PORT: '9000', COMMIT_MS: '5000', RPC_URL: 'http://localhost:8545' });

    expect(config.port).toBe(9000);
    expect(config.commitMs).toBe(5_000);
    expect(config.rpcUrl).toBe('http://localhost:8545');
  });

  it('turns a non-numeric duration into NaN rather than rejecting it', () => {
    // Known wrong. A NaN commitMs makes Room's `now < deadlineAt` false
    // forever, so every round resolves on the first tick and the match ends
    // immediately, with nothing logged anywhere.
    expect(loadConfig({ COMMIT_MS: 'twenty' }).commitMs).toBeNaN();
    expect(loadConfig({ WS_PORT: '' }).port).toBe(0);
  });

  it('accepts an escrow address that is not an address', () => {
    // Known wrong: the field is a cast, not a check, so a typo in .env reaches
    // viem instead of failing at boot.
    const config = loadConfig({ ESCROW_ADDRESS: 'oops', RPC_URL: 'http://localhost:8545' });

    expect(config.escrow).toBe('oops');
    expect(config.onChain).toBe(true);
  });

  it('is on-chain only when both an RPC and a non-zero escrow are set', () => {
    expect(loadConfig({ RPC_URL: 'http://x' }).onChain).toBe(false);
    expect(loadConfig({ ESCROW_ADDRESS: `0x${'11'.repeat(20)}` }).onChain).toBe(false);
    expect(
      loadConfig({ RPC_URL: 'http://x', ESCROW_ADDRESS: `0x${'11'.repeat(20)}` }).onChain,
    ).toBe(true);
  });

  it('survives destructuring, because reading the property runs the getter', () => {
    // Worth pinning: `onChain` reads `this`, which looks like it would break
    // under destructuring. It does not — destructuring reads the property, so
    // the getter runs and the boolean is what gets bound. What is lost is the
    // liveness, not the value, and nothing mutates a config after load.
    const { onChain } = loadConfig({ RPC_URL: 'http://x', ESCROW_ADDRESS: `0x${'11'.repeat(20)}` });

    expect(onChain).toBe(true);
  });

  it('silently reuses the attestor key as the keeper key', () => {
    // Known wrong: one key quietly takes three roles — result attestor, lobby
    // keeper, and (via index.ts) session relayer — with nothing logged.
    const pk = `0x${'22'.repeat(32)}`;
    expect(loadConfig({ ATTESTOR_PK: pk }).keeperPk).toBe(pk);
    expect(loadConfig({ ATTESTOR_PK: pk, KEEPER_PK: `0x${'33'.repeat(32)}` }).keeperPk).toBe(
      `0x${'33'.repeat(32)}`,
    );
  });
});

describe('relayer selection', () => {
  it('is the null relayer without a key or without a chain', () => {
    expect(relayerFrom(loadConfig({}))).toBe(nullRelayer);
    expect(relayerFrom(loadConfig({ ATTESTOR_PK: `0x${'22'.repeat(32)}` }))).toBe(nullRelayer);
    expect(
      relayerFrom(loadConfig({ RPC_URL: 'http://x', ESCROW_ADDRESS: `0x${'11'.repeat(20)}` })),
    ).toBe(nullRelayer);
  });

  it('builds a submitting relayer once a key and a chain are both present', () => {
    const relayer = relayerFrom(
      loadConfig({
        ATTESTOR_PK: `0x${'22'.repeat(32)}`,
        RPC_URL: 'http://localhost:8545',
        ESCROW_ADDRESS: `0x${'11'.repeat(20)}`,
      }),
    );

    expect(relayer).not.toBe(nullRelayer);
  });
});
