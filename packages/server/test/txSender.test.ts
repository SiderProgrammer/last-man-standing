import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { gameEscrowAbi } from '@lms/protocol';
import { RevertedError, TxSender, type ContractCall, type Fees, type TxPort } from '@lms/server';

const ESCROW = '0x00000000000000000000000000000000000000e5' as const;

function call(functionName = 'lockMatch'): ContractCall {
  return { address: ESCROW, abi: gameEscrowAbi, functionName, args: [`0x${'11'.repeat(32)}`] };
}

/**
 * A mempool on virtual time. A transaction is mined when the test says so,
 * by hash; until then it has no receipt. Time passes only in `sleep`.
 */
class FakeChain implements TxPort {
  readonly address = '0x00000000000000000000000000000000000000c0' as const;
  now = 0;
  private next = 0;
  readonly sent: Array<{ hash: Hex; nonce: number; fees: Fees; call: ContractCall }> = [];
  readonly status = new Map<Hex, 'success' | 'reverted'>();
  revertsWith: string | null = null;
  refuses: Error | null = null;
  resets = 0;
  /** Runs on every poll, as the chain moving on while the sender waits. */
  onPoll: (chain: FakeChain) => void = () => undefined;

  async simulate(): Promise<void> {
    if (this.revertsWith) throw new RevertedError(`reverts: ${this.revertsWith}`, this.revertsWith);
  }

  async nonce(): Promise<number> {
    return this.next++;
  }

  resetNonce(): void {
    this.resets += 1;
    this.next = this.sent.length === 0 ? 0 : Math.max(...this.sent.map((tx) => tx.nonce)) + 1;
  }

  async fees(): Promise<Fees> {
    return { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
  }

  async send(sent: ContractCall, nonce: number, fees: Fees): Promise<Hex> {
    if (this.refuses) throw this.refuses;
    const hash = `0x${(this.sent.length + 1).toString(16).padStart(64, '0')}` as Hex;
    this.sent.push({ hash, nonce, fees, call: sent });
    return hash;
  }

  async receipt(hash: Hex): Promise<'success' | 'reverted' | null> {
    return this.status.get(hash) ?? null;
  }

  sender(options: { stuckAfterMs?: number; maxBumps?: number } = {}): TxSender {
    return new TxSender(this, {
      pollMs: 1_000,
      stuckAfterMs: options.stuckAfterMs ?? 10_000,
      ...(options.maxBumps !== undefined ? { maxBumps: options.maxBumps } : {}),
      now: () => this.now,
      sleep: async (ms) => {
        this.now += ms;
        this.onPoll(this);
      },
    });
  }
}

describe('tx sender', () => {
  it('sends, follows the receipt, and frees the key once it lands', async () => {
    const chain = new FakeChain();
    chain.onPoll = (c) => {
      if (c.now >= 3_000) c.status.set(c.sent[0]?.hash as Hex, 'success');
    };
    const sender = chain.sender();
    const sent = await sender.send('lockMatch:a', call());
    expect(sent?.hash).toBe(chain.sent[0]?.hash);
    expect(sender.busy('lockMatch:a')).toBe(true);
    expect(await sent?.mined).toBe(chain.sent[0]?.hash);
    expect(sender.busy('lockMatch:a')).toBe(false);
  });

  it('sends nothing under a key whose transaction is still out', async () => {
    const chain = new FakeChain();
    const sender = chain.sender({ maxBumps: 0 });
    const first = await sender.send('settle:a', call('settle'));
    expect(await sender.send('settle:a', call('settle'))).toBeNull();
    // Another key is another transaction, with the next nonce.
    await sender.send('lockMatch:b', call());
    expect(chain.sent.map((tx) => tx.nonce)).toEqual([0, 1]);
    await first?.mined.catch(() => undefined);
  });

  it('refuses a call that would revert, without sending it', async () => {
    const chain = new FakeChain();
    chain.revertsWith = 'LobbyNotReady';
    const sender = chain.sender();
    const error = await sender.send('lockMatch:a', call()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RevertedError);
    expect((error as RevertedError).errorName).toBe('LobbyNotReady');
    expect(chain.sent).toEqual([]);
    expect(sender.busy('lockMatch:a')).toBe(false);
  });

  it('hands a nonce the node refused back, so the next send does not leave a gap', async () => {
    const chain = new FakeChain();
    chain.refuses = new Error('insufficient funds');
    const sender = chain.sender();
    await expect(sender.send('lockMatch:a', call())).rejects.toThrow(/insufficient funds/);
    expect(chain.resets).toBe(1);
    expect(sender.busy('lockMatch:a')).toBe(false);

    chain.refuses = null;
    chain.onPoll = (c) => c.status.set(c.sent[0]?.hash as Hex, 'success');
    await (await sender.send('lockMatch:a', call()))?.mined;
    expect(chain.sent.map((tx) => tx.nonce)).toEqual([0]);
  });

  it('replaces a stuck transaction at the same nonce with higher fees, and takes whichever lands', async () => {
    const chain = new FakeChain();
    chain.onPoll = (c) => {
      // Only the replacement is mined.
      if (c.sent.length === 2) c.status.set(c.sent[1]?.hash as Hex, 'success');
    };
    const sent = await chain.sender().send('settle:a', call('settle'));
    expect(await sent?.mined).toBe(chain.sent[1]?.hash);
    const [original, replacement] = chain.sent;
    expect(replacement?.nonce).toBe(original?.nonce);
    expect(replacement?.call).toEqual(original?.call);
    expect(replacement?.fees).toEqual({ maxFeePerGas: 125n, maxPriorityFeePerGas: 12n });
  });

  it('keeps following the original when it lands after all', async () => {
    const chain = new FakeChain();
    chain.onPoll = (c) => {
      if (c.sent.length === 2) {
        c.status.set(c.sent[0]?.hash as Hex, 'success');
        c.refuses = new Error('nonce too low');
      }
    };
    const sent = await chain.sender().send('settle:a', call('settle'));
    expect(await sent?.mined).toBe(chain.sent[0]?.hash);
  });

  it('gives up after its last replacement, and frees the key', async () => {
    const chain = new FakeChain();
    const sender = chain.sender({ maxBumps: 2 });
    const sent = await sender.send('settle:a', call('settle'));
    await expect(sent?.mined).rejects.toThrow(/no receipt after 2 replacements/);
    expect(chain.sent).toHaveLength(3);
    expect(sender.busy('settle:a')).toBe(false);
  });

  it('reports a transaction mined as a revert as a RevertedError', async () => {
    const chain = new FakeChain();
    chain.onPoll = (c) => c.status.set(c.sent[0]?.hash as Hex, 'reverted');
    const sent = await chain.sender().send('settle:a', call('settle'));
    await expect(sent?.mined).rejects.toBeInstanceOf(RevertedError);
  });
});
