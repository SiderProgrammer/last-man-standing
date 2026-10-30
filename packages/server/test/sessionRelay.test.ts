import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { delegationCode, joinCall, withdrawForCall, type RelayedCall } from '@lms/protocol';
import { SessionRelay, type RelayPort } from '@lms/server';

const ESCROW = `0x${'e5'.repeat(20)}` as const;
const DELEGATE = `0x${'de'.repeat(20)}` as const;
const PLAYER = `0x${'a1'.repeat(20)}` as const;
const MATCH = `0x${'cd'.repeat(32)}` as const;
const STAKE = 10n ** 15n;
const DAY = 24 * 60 * 60 * 1000;

/** Records what would have been sent, and answers with a made-up hash. */
class FakePort implements RelayPort {
  readonly sent: Array<{ account: Address; call: RelayedCall }> = [];
  code: Hex | undefined = delegationCode(DELEGATE);
  failNext = false;

  async codeOf(): Promise<Hex | undefined> {
    return this.code;
  }

  async submit(account: Address, call: RelayedCall): Promise<Hex> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('execution reverted: SpendCapExceeded\nmore detail');
    }
    this.sent.push({ account, call });
    return `0x${String(this.sent.length).padStart(64, '0')}`;
  }
}

function relayed(params: { target: Address; value: bigint; data: Hex }): RelayedCall {
  return { target: params.target, value: params.value.toString(), data: params.data, nonce: '0', signature: '0x1234' };
}

function setup(quotaPerDay = 3) {
  const port = new FakePort();
  let now = 10 * DAY + 1_000;
  const relay = new SessionRelay({ port, escrow: ESCROW, delegate: DELEGATE, quotaPerDay, now: () => now });
  return { port, relay, advance: (ms: number) => (now += ms) };
}

describe('SessionRelay', () => {
  it('relays a join and a withdrawal for the wallet that asked', async () => {
    const { port, relay } = setup();

    const join = await relay.relay(PLAYER, relayed(joinCall(ESCROW, MATCH, STAKE)));
    expect(join).toMatchObject({ kind: 'join', left: 2 });
    const withdraw = await relay.relay(PLAYER, relayed(withdrawForCall(ESCROW, PLAYER)));
    expect(withdraw).toMatchObject({ kind: 'withdrawFor', left: 1 });

    expect(port.sent.map((entry) => entry.account)).toEqual([PLAYER, PLAYER]);
  });

  /** Turned away before any RPC: the server's gas is not spent finding out. */
  it('refuses a call outside the session scope without touching the chain', async () => {
    const { port, relay } = setup();
    port.code = undefined;

    await expect(relay.relay(PLAYER, relayed(joinCall(PLAYER, MATCH, STAKE)))).rejects.toMatchObject({
      code: 'RELAY_REFUSED',
    });
    await expect(relay.relay(PLAYER, relayed(withdrawForCall(ESCROW, ESCROW)))).rejects.toMatchObject({
      code: 'RELAY_REFUSED',
    });
    expect(port.sent).toHaveLength(0);
    expect(relay.left(PLAYER)).toBe(3);
  });

  /** The call runs as the account's code, so that code must be ours. */
  it('refuses an account that is not delegated to this delegate', async () => {
    const { port, relay } = setup();
    const call = relayed(joinCall(ESCROW, MATCH, STAKE));

    port.code = undefined;
    await expect(relay.relay(PLAYER, call)).rejects.toMatchObject({ code: 'RELAY_REFUSED' });
    port.code = delegationCode(ESCROW);
    await expect(relay.relay(PLAYER, call)).rejects.toMatchObject({ code: 'RELAY_REFUSED' });
    expect(port.sent).toHaveLength(0);
  });

  it('stops a wallet at its daily quota, and starts it again the next UTC day', async () => {
    const { relay, advance } = setup(2);
    const call = relayed(joinCall(ESCROW, MATCH, STAKE));

    await relay.relay(PLAYER, call);
    await relay.relay(PLAYER, call);
    await expect(relay.relay(PLAYER, call)).rejects.toMatchObject({ code: 'RELAY_QUOTA' });
    // Another wallet has its own.
    const other = `0x${'b2'.repeat(20)}` as const;
    await expect(relay.relay(other, relayed(withdrawForCall(ESCROW, other)))).resolves.toMatchObject({ left: 1 });

    advance(DAY);
    expect(relay.left(PLAYER)).toBe(2);
    await expect(relay.relay(PLAYER, call)).resolves.toMatchObject({ left: 1 });
  });

  it('hands the slot back when the call would revert, and says why', async () => {
    const { port, relay } = setup(1);
    port.failNext = true;

    await expect(relay.relay(PLAYER, relayed(joinCall(ESCROW, MATCH, STAKE)))).rejects.toMatchObject({
      code: 'RELAY_REFUSED',
      message: 'the call would fail: execution reverted: SpendCapExceeded',
    });
    expect(relay.left(PLAYER)).toBe(1);
  });

  /** Two joins racing must not both take the last slot. */
  it('counts a call while it is in flight', async () => {
    const { relay } = setup(1);
    const call = relayed(joinCall(ESCROW, MATCH, STAKE));

    const results = await Promise.allSettled([relay.relay(PLAYER, call), relay.relay(PLAYER, call)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});
