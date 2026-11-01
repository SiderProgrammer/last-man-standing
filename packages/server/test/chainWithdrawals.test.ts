import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { type ChainWithdrawal } from '@lms/consensus';
import { joinCall, type BridgeQuote } from '@lms/contracts';
import { quoteToWire, withdrawalToWire, type ClientMessage } from '@lms/api';
import {
  ChainWithdrawals,
  DailyQuota,
  SessionRelay,
  parseClientMessage,
  type HubBalance,
  type RelayPort,
  type WithdrawalPort,
} from '@lms/server';

const HUB = 8453;
const SPOKE = 42161;
const PLAYER = `0x${'a1'.repeat(20)}` as const;
const OTHER = `0x${'b2'.repeat(20)}` as const;
const RECEIVER = `0x${'bb'.repeat(20)}` as const;
const WETH = `0x${'4e'.repeat(20)}` as const;
const ESCROW = `0x${'e5'.repeat(20)}` as const;
const DELEGATE = `0x${'de'.repeat(20)}` as const;

class FakePort implements WithdrawalPort {
  readonly sent: Array<{ withdrawal: ChainWithdrawal; quote: BridgeQuote; signature: Hex }> = [];
  revert: string | null = null;

  async balance(): Promise<HubBalance> {
    return { amount: 5n * 10n ** 15n, receiver: RECEIVER, nonce: 2n, minimum: 10n ** 15n, chainTime: 1_700_000_000 };
  }

  async submit(withdrawal: ChainWithdrawal, quote: BridgeQuote, signature: Hex): Promise<Hex> {
    if (this.revert) throw new Error(`execution reverted: ${this.revert}`);
    this.sent.push({ withdrawal, quote, signature });
    return `0x${String(this.sent.length).padStart(64, '0')}`;
  }
}

function withdrawal(overrides: Partial<ChainWithdrawal> = {}): ChainWithdrawal {
  return {
    player: PLAYER,
    hubChainId: BigInt(HUB),
    destinationChainId: BigInt(SPOKE),
    recipient: PLAYER,
    outputToken: WETH,
    maxFee: 10n ** 13n,
    nonce: 2n,
    deadline: 1_700_000_600n,
    ...overrides,
  };
}

const QUOTE: BridgeQuote = {
  outputAmount: 49n * 10n ** 14n,
  quoteTimestamp: 1_700_000_000,
  fillDeadline: 1_700_003_600,
  exclusiveRelayer: `0x${'00'.repeat(20)}`,
  exclusivityParameter: 0,
};

function message(overrides: Partial<ChainWithdrawal> = {}): Extract<ClientMessage, { type: 'withdrawToChain' }> {
  return {
    type: 'withdrawToChain',
    id: 'w-1',
    withdrawal: withdrawalToWire(withdrawal(overrides)),
    quote: quoteToWire(QUOTE),
    signature: '0x1234',
  };
}

function setup(perDay = 3) {
  const port = new FakePort();
  const quota = new DailyQuota(perDay);
  const withdrawals = new ChainWithdrawals({ port, hubChainId: HUB, spokes: [{ chainId: SPOKE, router: `0x${'50'.repeat(20)}` }], quota });
  return { port, quota, withdrawals };
}

describe('ChainWithdrawals', () => {
  it('submits the wallet own signed withdrawal, exactly as signed', async () => {
    const { port, withdrawals } = setup();
    const { tx, left } = await withdrawals.submit(PLAYER, message());

    expect(tx).toMatch(/^0x0+1$/);
    expect(left).toBe(2);
    expect(port.sent[0]).toEqual({ withdrawal: withdrawal(), quote: QUOTE, signature: '0x1234' });
  });

  /** The receiver would refuse it anyway; refusing first saves the relayer a simulation for a stranger. */
  it("refuses another wallet's withdrawal from this login", async () => {
    const { port, withdrawals } = setup();
    await expect(withdrawals.submit(OTHER, message())).rejects.toMatchObject({ code: 'RELAY_REFUSED' });
    expect(port.sent).toEqual([]);
  });

  it('refuses a withdrawal for another hub, or to a chain this server does not bridge to', async () => {
    const { withdrawals } = setup();
    await expect(withdrawals.submit(PLAYER, message({ hubChainId: 1n }))).rejects.toThrow(/another hub/);
    await expect(withdrawals.submit(PLAYER, message({ destinationChainId: 10n }))).rejects.toThrow(/does not bridge/);
  });

  it('says why the receiver would refuse it, and gives the quota back', async () => {
    const { port, quota, withdrawals } = setup();
    port.revert = 'FeeTooHigh';
    await expect(withdrawals.submit(PLAYER, message())).rejects.toMatchObject({
      code: 'RELAY_REFUSED',
      message: expect.stringContaining('FeeTooHigh'),
    });
    expect(quota.left(PLAYER)).toBe(3);
  });

  /** One key's gas, so one count: withdrawals and one-click calls draw on the same quota. */
  it('shares the daily quota with one-click calls', async () => {
    const { quota, withdrawals } = setup(2);
    const relayPort: RelayPort = {
      codeOf: async () => `0xef0100${DELEGATE.slice(2)}` as Hex,
      submit: async () => `0x${'11'.repeat(32)}` as Hex,
    };
    const relay = new SessionRelay({ port: relayPort, escrow: ESCROW, delegate: DELEGATE, quotaPerDay: 99, quota });
    const join = joinCall(ESCROW, `0x${'cd'.repeat(32)}`, 10n ** 15n);
    await relay.relay(PLAYER, { target: join.target, value: join.value.toString(), data: join.data, nonce: '0', signature: '0x12' });
    await withdrawals.submit(PLAYER, message());

    await expect(withdrawals.submit(PLAYER, message())).rejects.toMatchObject({ code: 'RELAY_QUOTA' });
    expect(relay.quotaPerDay).toBe(2);
  });

  it('reads the balance and the receiver terms for the wallet', async () => {
    const { withdrawals } = setup();
    await expect(withdrawals.balance(PLAYER as Address)).resolves.toMatchObject({ receiver: RECEIVER, nonce: 2n });
  });
});

describe('withdrawal frames', () => {
  it('parse back into the message the client sent', () => {
    const sent = message();
    expect(parseClientMessage(JSON.stringify(sent))).toEqual(sent);
    expect(parseClientMessage(JSON.stringify({ type: 'balance' }))).toEqual({ type: 'balance' });
  });

  it('refuse a withdrawal with an amount that is not a decimal string', () => {
    const sent = message();
    const bad = { ...sent, withdrawal: { ...sent.withdrawal, maxFee: '1e18' } };
    expect(() => parseClientMessage(JSON.stringify(bad))).toThrow(/withdrawal\.maxFee/);
  });
});
