import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { VerifyPool, layeredVerifier } from '@lms/server';

const account = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'66'.repeat(32)}`);
const message = 'Last Man Standing login\nnonce:abc';

let pool: VerifyPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe('verify pool', () => {
  it('recovers signatures on worker threads', async () => {
    pool = new VerifyPool(2);
    const good = await account.signMessage({ message });
    const bad = await stranger.signMessage({ message });

    const results = await Promise.all([
      pool.verify({ address: account.address, message, signature: good }),
      pool.verify({ address: account.address, message, signature: bad }),
      pool.verify({ address: account.address, message, signature: '0x1234' }),
    ]);
    expect(results).toEqual([true, false, false]);
  });

  it('recovers inline with no threads', async () => {
    pool = new VerifyPool(0);
    const good = await account.signMessage({ message });
    expect(await pool.verify({ address: account.address, message, signature: good })).toBe(true);
  });
});

describe('layered verifier', () => {
  it('asks the fallback only when local recovery fails', async () => {
    const asked: string[] = [];
    const verify = layeredVerifier(
      async ({ signature }) => signature === '0xaa',
      async ({ signature }) => {
        asked.push(signature);
        return signature === '0xbb';
      },
    );
    expect(await verify({ address: account.address, message, signature: '0xaa' })).toBe(true);
    expect(await verify({ address: account.address, message, signature: '0xbb' })).toBe(true);
    expect(await verify({ address: account.address, message, signature: '0xcc' })).toBe(false);
    expect(asked).toEqual(['0xbb', '0xcc']);
  });
});
