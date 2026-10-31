import { describe, expect, it } from 'vitest';
import { ZERO_ADDRESS } from '@lms/protocol';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ConfigError,
  loadConfig,
  readDeployment,
  relayerFrom,
  nullRelayer,
  viemTxSender,
  type Deployment,
} from '@lms/server';

const ESCROW = `0x${'11'.repeat(20)}` as const;
const GOVERNOR = `0x${'22'.repeat(20)}` as const;
const DEPLOYMENT: Deployment = { chainId: 84532, deployBlock: 1234, contracts: { escrow: ESCROW, governor: GOVERNOR } };

describe('deployment registry', () => {
  it('fills addresses and scan start blocks the environment leaves unset', () => {
    const config = loadConfig({ CHAIN_ID: '84532' }, (chainId) => (chainId === 84532 ? DEPLOYMENT : null));

    expect(config.escrow).toBe(ESCROW);
    expect(config.governor).toBe(GOVERNOR);
    expect(config.governorFromBlock).toBe(1234n);
    expect(config.crossChainFromBlock).toBe(1234n);
    // Not in the registry: still the zero address.
    expect(config.feeRouter).toBe(ZERO_ADDRESS);
  });

  it('lets the environment override the registry', () => {
    const other = `0x${'33'.repeat(20)}`;
    const config = loadConfig({ CHAIN_ID: '84532', ESCROW_ADDRESS: other, GOVERNOR_FROM_BLOCK: '7' }, () => DEPLOYMENT);

    expect(config.escrow).toBe(other);
    expect(config.governorFromBlock).toBe(7n);
  });

  it('reads the file the deploy script writes, and refuses one for another chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lms-deployments-'));
    writeFileSync(join(dir, '84532.json'), JSON.stringify(DEPLOYMENT));
    writeFileSync(join(dir, '1.json'), JSON.stringify(DEPLOYMENT));
    const url = pathToFileURL(`${dir}/`);

    expect(readDeployment(84532, url)).toEqual(DEPLOYMENT);
    expect(readDeployment(11155111, url)).toBeNull();
    expect(() => readDeployment(1, url)).toThrow(/is for chain 84532, not 1/);
  });
});

describe('server configuration', () => {
  it('falls back to working defaults on an empty environment', () => {
    const config = loadConfig({});

    expect(config.port).toBe(8787);
    expect(config.chainId).toBe(84532);
    expect(config.commitMs).toBe(20_000);
    expect(config.revealMs).toBe(12_000);
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

  it('refuses a non-numeric duration instead of running on NaN', () => {
    // A NaN commitMs would make Room's `now < deadlineAt` false forever, so
    // every round would resolve on the first tick.
    expect(() => loadConfig({ COMMIT_MS: 'twenty' })).toThrow(/COMMIT_MS must be a whole number/);
    expect(() => loadConfig({ COMMIT_MS: '0' })).toThrow(/COMMIT_MS must be at least 1/);
    expect(() => loadConfig({ WS_PORT: '-1' })).toThrow(ConfigError);
  });

  it('treats a blank variable as unset', () => {
    expect(loadConfig({ WS_PORT: '', ESCROW_ADDRESS: '', COMMIT_MS: '' })).toMatchObject({
      port: 8787,
      escrow: ZERO_ADDRESS,
      commitMs: 20_000,
    });
  });

  it('refuses an address, key or URL that is not one', () => {
    expect(() => loadConfig({ ESCROW_ADDRESS: 'oops' })).toThrow(/ESCROW_ADDRESS must be a 20-byte hex address/);
    expect(() => loadConfig({ ATTESTOR_PK: '0x1234' })).toThrow(/ATTESTOR_PK must be a 32-byte hex private key/);
    expect(() => loadConfig({ RPC_URL: 'localhost:8545 typo' })).toThrow(/RPC_URL must be an http\(s\) or ws\(s\) URL/);
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY must be true or false/);
    expect(() => loadConfig({ GATEWAY_LIMITS: '{nope' })).toThrow(/GATEWAY_LIMITS must be valid JSON/);
  });

  it('lists every problem at once', () => {
    expect(() => loadConfig({ COMMIT_MS: 'x', REVEAL_MS: 'y', ESCROW_ADDRESS: 'z' })).toThrow(
      /COMMIT_MS[\s\S]*REVEAL_MS[\s\S]*ESCROW_ADDRESS/,
    );
  });

  it('refuses to run in production without a database unless told to keep memory', () => {
    const origins = { ALLOWED_ORIGINS: 'https://play.example' };
    expect(() => loadConfig({ NODE_ENV: 'production', ...origins })).toThrow(/DATABASE_URL is required in production/);
    expect(loadConfig({ NODE_ENV: 'production', ARCHIVE: 'memory', ...origins }).databaseUrl).toBe('');
    expect(loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db/lms', ...origins }).databaseUrl).toBe(
      'postgresql://u:p@db/lms',
    );
    expect(() => loadConfig({ ARCHIVE: 'postgres' })).toThrow(/ARCHIVE=postgres needs DATABASE_URL/);
  });

  it('refuses to run in production without allowed origins unless told to accept any', () => {
    const production = { NODE_ENV: 'production', ARCHIVE: 'memory' };
    expect(() => loadConfig(production)).toThrow(/ALLOWED_ORIGINS is required in production/);
    expect(() => loadConfig({ ...production, ALLOWED_ORIGINS: ' ' })).toThrow(/ALLOWED_ORIGINS is required/);
    expect(loadConfig({ ...production, ALLOWED_ORIGINS: '*' }).allowedOrigins).toEqual([]);
    expect(loadConfig({ ...production, ALLOWED_ORIGINS: 'https://play.example' }).allowedOrigins).toEqual([
      'https://play.example',
    ]);
  });

  it('reads the gateway limits, defaulting to permissive-but-bounded values', () => {
    const defaults = loadConfig({});
    expect(defaults.maxConnectionsPerIp).toBe(20);
    expect(defaults.allowedOrigins).toEqual([]);
    expect(defaults.trustProxy).toBe(false);

    const tuned = loadConfig({ ALLOWED_ORIGINS: 'https://a.example, https://b.example,', TRUST_PROXY: 'true' });
    expect(tuned.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(tuned.trustProxy).toBe(true);

    expect(loadConfig({ GATEWAY_LIMITS: '{"messageRate":50,"bogus":"x"}' }).gatewayLimits).toEqual({ messageRate: 50 });
    expect(loadConfig({ VERIFY_THREADS: '0' }).verifyThreads).toBe(0);
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
    // Separated in docs/FIX_PLAN.md step 7.4.
    const pk = `0x${'22'.repeat(32)}`;
    expect(loadConfig({ ATTESTOR_PK: pk }).keeperPk).toBe(pk);
    expect(loadConfig({ ATTESTOR_PK: pk, KEEPER_PK: `0x${'33'.repeat(32)}` }).keeperPk).toBe(
      `0x${'33'.repeat(32)}`,
    );
  });
});

describe('relayer selection', () => {
  const sender = viemTxSender({ privateKey: `0x${'22'.repeat(32)}`, chainId: 84532, rpcUrl: 'http://localhost:8545' });

  it('is the null relayer without a key, a chain or a sender', () => {
    expect(relayerFrom(loadConfig({}), sender)).toBe(nullRelayer);
    expect(relayerFrom(loadConfig({ ATTESTOR_PK: `0x${'22'.repeat(32)}` }), sender)).toBe(nullRelayer);
    expect(
      relayerFrom(loadConfig({ RPC_URL: 'http://x', ESCROW_ADDRESS: `0x${'11'.repeat(20)}` }), sender),
    ).toBe(nullRelayer);
    const configured = loadConfig({
      ATTESTOR_PK: `0x${'22'.repeat(32)}`,
      RPC_URL: 'http://localhost:8545',
      ESCROW_ADDRESS: `0x${'11'.repeat(20)}`,
    });
    expect(relayerFrom(configured, null)).toBe(nullRelayer);
  });

  it('builds a submitting relayer once a key, a chain and a sender are all present', () => {
    const relayer = relayerFrom(
      loadConfig({
        ATTESTOR_PK: `0x${'22'.repeat(32)}`,
        RPC_URL: 'http://localhost:8545',
        ESCROW_ADDRESS: `0x${'11'.repeat(20)}`,
      }),
      sender,
    );

    expect(relayer).not.toBe(nullRelayer);
  });
});
