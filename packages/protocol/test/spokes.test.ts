import { describe, expect, it, vi } from 'vitest';
import { hashTypedData, type Address } from 'viem';
import {
  FEE_BUFFER_BPS,
  LOCAL_FILL_SECONDS,
  WITHDRAWAL_TYPES,
  joinMessage,
  localQuote,
  quoteAcross,
  quoteAcrossFrom,
  withdrawalDomain,
  withdrawalFromWire,
  withdrawalToWire,
  type AcrossRoute,
} from '../src/chain/spokes.js';

const MATCH = `0x${'cd'.repeat(32)}` as const;
const PLAYER: Address = `0x${'aa'.repeat(20)}`;
const STAKE = 10n ** 16n;

const ROUTE: AcrossRoute = {
  originChainId: 421614,
  destinationChainId: 84532,
  inputToken: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
  outputToken: '0x4200000000000000000000000000000000000006',
  recipient: `0x${'11'.repeat(20)}`,
  message: joinMessage(MATCH, PLAYER, 421614),
};

/** What the suggested-fees API answers, trimmed to what is read. */
function answer(fee: bigint, over: Record<string, unknown> = {}) {
  return {
    totalRelayFee: { pct: '0', total: fee.toString() },
    timestamp: '1793403468',
    fillDeadline: '1793410668',
    exclusiveRelayer: '0x0000000000000000000000000000000000000000',
    exclusivityDeadline: 0,
    isAmountTooLow: false,
    ...over,
  };
}

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch &
    ReturnType<typeof vi.fn>;
}

describe('joinMessage', () => {
  /** `SpokeRouter.joinMessage` is `abi.encode(matchId, player, uint32(chainid))`. */
  it('is the router message: three words, the chain last', () => {
    expect(joinMessage(MATCH, PLAYER, 421614)).toBe(
      `0x${'cd'.repeat(32)}${'0'.repeat(24)}${'aa'.repeat(20)}${'0'.repeat(59)}66eee`,
    );
  });
});

describe('quoteAcross', () => {
  it('asks for the stake to arrive and adds the fee, with a buffer for the relayer', async () => {
    const fee = 2_385_554_129_997n;
    const fetchFn = fakeFetch(200, answer(fee));
    const { inputAmount, quote } = await quoteAcross('https://testnet.across.to/api/', ROUTE, STAKE, fetchFn);

    const buffer = (fee * FEE_BUFFER_BPS + 9_999n) / 10_000n;
    expect(inputAmount).toBe(STAKE + fee + buffer);
    expect(quote).toEqual({
      outputAmount: STAKE,
      quoteTimestamp: 1793403468,
      fillDeadline: 1793410668,
      exclusiveRelayer: '0x0000000000000000000000000000000000000000',
      exclusivityParameter: 0,
    });

    const url = new URL(fetchFn.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://testnet.across.to/api/suggested-fees');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      inputToken: ROUTE.inputToken,
      outputToken: ROUTE.outputToken,
      originChainId: '421614',
      destinationChainId: '84532',
      amount: STAKE.toString(),
      recipient: ROUTE.recipient,
      message: ROUTE.message,
    });
  });

  it('passes an exclusive relayer and its window through', async () => {
    const relayer = `0x${'39'.repeat(20)}`;
    const fetchFn = fakeFetch(200, answer(1n, { exclusiveRelayer: relayer, exclusivityDeadline: 3 }));
    const { quote } = await quoteAcross('https://app.across.to/api', ROUTE, STAKE, fetchFn);
    expect(quote.exclusiveRelayer).toBe(relayer);
    expect(quote.exclusivityParameter).toBe(3);
  });

  it('refuses an amount Across will not move, and says why it would not quote', async () => {
    await expect(
      quoteAcross('https://app.across.to/api', ROUTE, 1n, fakeFetch(200, answer(1n, { isAmountTooLow: true }))),
    ).rejects.toThrow('Across will not bridge an amount this small.');
    await expect(
      quoteAcross('https://app.across.to/api', ROUTE, STAKE, fakeFetch(400, { message: 'Unsupported route' })),
    ).rejects.toThrow('Across would not quote: Unsupported route');
  });
});

describe('quoteAcrossFrom', () => {
  /** A withdrawal: the whole balance goes in, and the fee and the buffer come out of it. */
  it('prices an exact input, taking the fee and the buffer from it', async () => {
    const fee = 1_000_000_000_000n;
    const fetchFn = fakeFetch(200, answer(fee));
    const { outputAmount, quote } = await quoteAcrossFrom('https://app.across.to/api', ROUTE, STAKE, fetchFn);

    const buffer = (fee * FEE_BUFFER_BPS + 9_999n) / 10_000n;
    expect(outputAmount).toBe(STAKE - fee - buffer);
    expect(quote.outputAmount).toBe(outputAmount);
    expect(new URL(fetchFn.mock.calls[0]![0] as string).searchParams.get('amount')).toBe(STAKE.toString());
  });

  it('refuses a balance the fee would swallow', async () => {
    await expect(quoteAcrossFrom('https://app.across.to/api', ROUTE, 100n, fakeFetch(200, answer(100n)))).rejects.toThrow(
      'Across would take all of it in fees.',
    );
  });
});

describe('withdrawal over the wire', () => {
  it('survives the trip as decimal strings', () => {
    const withdrawal = {
      player: PLAYER,
      hubChainId: 8453n,
      destinationChainId: 42161n,
      recipient: PLAYER,
      outputToken: ROUTE.outputToken,
      maxFee: 12_345n,
      nonce: 7n,
      deadline: 1_793_403_468n,
    };
    const wire = JSON.parse(JSON.stringify(withdrawalToWire(withdrawal)));
    expect(withdrawalFromWire(wire)).toEqual(withdrawal);
  });
});

describe('localQuote', () => {
  it('charges nothing and stamps the chain time', () => {
    expect(localQuote(STAKE, 1_000)).toEqual({
      inputAmount: STAKE,
      quote: {
        outputAmount: STAKE,
        quoteTimestamp: 1_000,
        fillDeadline: 1_000 + LOCAL_FILL_SECONDS,
        exclusiveRelayer: '0x0000000000000000000000000000000000000000',
        exclusivityParameter: 0,
      },
    });
  });
});

describe('withdrawal typed data', () => {
  /**
   * Frozen, and the same vector as `BridgeJoinReceiver.t.sol`'s
   * `test_withdrawalDigest_frozenVector`: what a wallet signs here is what the
   * receiver checks.
   */
  it('hashes to the digest the receiver checks', () => {
    const digest = hashTypedData({
      domain: withdrawalDomain(`0x${'11'.repeat(20)}`),
      types: WITHDRAWAL_TYPES,
      primaryType: 'Withdrawal',
      message: {
        player: PLAYER,
        hubChainId: 84532n,
        destinationChainId: 421614n,
        recipient: `0x${'bb'.repeat(20)}`,
        outputToken: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
        maxFee: 10n ** 15n,
        nonce: 3n,
        deadline: 1_800_000_000n,
      },
    });
    expect(digest).toBe('0x5c24035ab95701f0bcca63331fc1c2ba82b5cb6496e7c6b90d93b33359b63b13');
  });
});
