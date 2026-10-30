import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Action,
  GRANT_DOMAIN,
  MAX_GRANT_SECONDS,
  commitTypedData,
  grantProblem,
  grantTypedData,
  revealTypedData,
  type SessionGrant,
} from '@lms/protocol';

const wallet = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const key = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const MATCH = `0x${'cc'.repeat(32)}` as const;
const SALT = `0x${'5a'.repeat(32)}` as const;

const GRANT: SessionGrant = {
  wallet: wallet.address,
  sessionKey: key.address,
  domain: 'play.test',
  uri: 'https://play.test',
  chainId: 84532,
  issuedAt: 1_000,
  expiresAt: 1_000 + 3_600,
  nonce: `0x${'01'.repeat(32)}`,
};

describe('session grants', () => {
  it('accepts a grant that is current and for this chain', () => {
    expect(grantProblem(GRANT, { chainId: 84532, now: 2_000 })).toBeNull();
  });

  it('names what is wrong with one that is not', () => {
    const at = (grant: Partial<SessionGrant>, now = 2_000, origins: string[] = []) =>
      grantProblem({ ...GRANT, ...grant }, { chainId: 84532, now, origins });
    expect(at({ chainId: 1 })).toMatch(/chain 1/);
    expect(at({}, 4_600)).toMatch(/expired/);
    expect(at({ issuedAt: 3_000, expiresAt: 4_000 }, 2_000 - 1_000)).toMatch(/future/);
    expect(at({ expiresAt: 1_000 + MAX_GRANT_SECONDS + 1 })).toMatch(/longer than a week/);
    expect(at({ domain: 'other.test' })).toMatch(/domain/);
    expect(at({ uri: 'not a url' })).toMatch(/domain/);
    expect(at({}, 2_000, ['https://elsewhere.test'])).toMatch(/origin/);
    expect(at({}, 2_000, ['https://play.test'])).toBeNull();
  });

  /** Wallets refuse typed data for a chain they are not on; a spoke player must still log in. */
  it('leaves the chain out of the grant domain', () => {
    expect(GRANT_DOMAIN).not.toHaveProperty('chainId');
  });

  it('recovers to the wallet that signed it', async () => {
    const signature = await wallet.signTypedData(grantTypedData(GRANT));
    expect(await recoverTypedDataAddress({ ...grantTypedData(GRANT), signature })).toBe(wallet.address);
  });
});

describe('signed moves', () => {
  const place = { matchId: MATCH, round: 3, seat: 2 };

  it('binds a commit to its match, round and seat', () => {
    const digest = hashTypedData(commitTypedData(84532, place, SALT));
    expect(hashTypedData(commitTypedData(84532, { ...place, round: 4 }, SALT))).not.toBe(digest);
    expect(hashTypedData(commitTypedData(84532, { ...place, seat: 1 }, SALT))).not.toBe(digest);
    expect(hashTypedData(commitTypedData(1, place, SALT))).not.toBe(digest);
  });

  it('signs a reveal with the target zeroed for anything but Strike', () => {
    const guard = revealTypedData(84532, place, { action: Action.Guard, target: 5, salt: SALT });
    expect(guard.message.target).toBe(0);
    const strike = revealTypedData(84532, place, { action: Action.Strike, target: 5, salt: SALT });
    expect(strike.message.target).toBe(5);
  });

  it('recovers a reveal to the session key', async () => {
    const data = revealTypedData(84532, place, { action: Action.Strike, target: 1, salt: SALT });
    const signature = await key.signTypedData(data);
    expect(await recoverTypedDataAddress({ ...data, signature })).toBe(key.address);
  });
});
