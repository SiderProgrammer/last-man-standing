import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { bridgeJoinReceiverAbi, spokeRouterAbi } from './abis.js';

/**
 * Joining a hub lobby from a spoke chain, through Across.
 *
 * A player on a spoke calls `SpokeRouter.join`, which deposits the stake into
 * Across's SpokePool there. A relayer fills it on the hub, paying
 * `BridgeJoinReceiver`, which hands it to the escrow: a seat, or the value
 * credited to the player on the hub if the seat is gone by then. Shared
 * because the server watches the hub end and the client drives the spoke end,
 * and both have to agree with the deployed contracts.
 */

/** The `SpokeRouter` surface the client calls. */
export { spokeRouterAbi };

/** `BridgeJoinReceiver`: its fills, and the signed way back out. */
export { bridgeJoinReceiverAbi };

/** Mirrors `GameEscrow.JoinFailure`: why a bridged stake was credited instead of seated. */
export const JoinFailure = {
  None: 0,
  Paused: 1,
  UnknownMatch: 2,
  NotOpen: 3,
  WindowClosed: 4,
  LobbyFull: 5,
  AlreadyJoined: 6,
  StakeTooLow: 7,
  /** A matchmade lobby whose roster does not name the player. */
  NotRostered: 8,
} as const;

export type JoinFailureValue = (typeof JoinFailure)[keyof typeof JoinFailure];

/** Why the hub refunded a join, as the player should read it. */
export function joinFailureText(reason: number): string {
  switch (reason) {
    case JoinFailure.Paused:
      return 'play was paused';
    case JoinFailure.UnknownMatch:
      return 'the hub does not know that lobby';
    case JoinFailure.NotOpen:
      return 'the lobby had already closed';
    case JoinFailure.WindowClosed:
      return 'the join window ended while your stake was in transit';
    case JoinFailure.LobbyFull:
      return 'the lobby filled while your stake was in transit';
    case JoinFailure.AlreadyJoined:
      return 'you already had a seat in it';
    case JoinFailure.StakeTooLow:
      return 'less than the stake arrived';
    case JoinFailure.NotRostered:
      return 'that lobby was matched for other players'
    default:
      return 'the seat could not be taken';
  }
}

// ------------------------------------------------------------------ Across

/** Across's fee API on mainnet and on testnet. */
export const ACROSS_API = {
  mainnet: 'https://app.across.to/api',
  testnet: 'https://testnet.across.to/api',
} as const;

/**
 * The fee terms `SpokeRouter.join` and `BridgeJoinReceiver.withdrawToChainFor`
 * take as `quote`, from Across's suggested-fees answer.
 */
export interface BridgeQuote {
  /** What arrives: exactly this, or nothing until the deposit is refunded. */
  outputAmount: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusiveRelayer: Address;
  exclusivityParameter: number;
}

/** One transfer through Across, as its API and the deposit describe it. */
export interface AcrossRoute {
  originChainId: number;
  destinationChainId: number;
  /** WETH on the origin chain: Across moves ETH as its wrapped token. */
  inputToken: Address;
  /** WETH on the destination. */
  outputToken: Address;
  recipient: Address;
  /** The handler's message, which the fee covers the gas of. Empty for none. */
  message: Hex;
}

/**
 * The relayer's share above the quoted fee, in basis points of the fee. A
 * fill is exact, so a fee that rises before a relayer takes the deposit
 * leaves it waiting; a little over the quote keeps it worth filling. It goes
 * to the relayer, not the player.
 */
export const FEE_BUFFER_BPS = 1_000n;

/**
 * What it costs to have exactly `outputAmount` arrive on the far side: the
 * input to send, and the quote to send it with.
 *
 * The API prices a given input; for an exact output this asks for the output
 * itself, and adds the fee it names, plus `FEE_BUFFER_BPS` of it, on top.
 */
export async function quoteAcross(
  api: string,
  route: AcrossRoute,
  outputAmount: bigint,
  fetchFn: typeof fetch = fetch,
): Promise<{ inputAmount: bigint; quote: BridgeQuote }> {
  const params = feeParams(route, outputAmount);
  const body = await suggestedFees(api, params, fetchFn);
  const fee = BigInt(body.totalRelayFee.total);
  const buffer = (fee * FEE_BUFFER_BPS + 9_999n) / 10_000n;
  return { inputAmount: outputAmount + fee + buffer, quote: quoteFrom(body, outputAmount) };
}

/**
 * The other way round: what arrives for exactly `inputAmount` sent, which is
 * how a withdrawal is priced — the whole balance goes in, and the fee comes
 * out of it. The same `FEE_BUFFER_BPS` over the quoted fee goes to the relayer.
 */
export async function quoteAcrossFrom(
  api: string,
  route: AcrossRoute,
  inputAmount: bigint,
  fetchFn: typeof fetch = fetch,
): Promise<{ outputAmount: bigint; quote: BridgeQuote }> {
  const body = await suggestedFees(api, feeParams(route, inputAmount), fetchFn);
  const fee = BigInt(body.totalRelayFee.total);
  const buffer = (fee * FEE_BUFFER_BPS + 9_999n) / 10_000n;
  const outputAmount = inputAmount - fee - buffer;
  if (outputAmount <= 0n) throw new Error('Across would take all of it in fees.');
  return { outputAmount, quote: quoteFrom(body, outputAmount) };
}

function feeParams(route: AcrossRoute, amount: bigint): URLSearchParams {
  const params = new URLSearchParams({
    inputToken: route.inputToken,
    outputToken: route.outputToken,
    originChainId: String(route.originChainId),
    destinationChainId: String(route.destinationChainId),
    amount: amount.toString(),
    recipient: route.recipient,
  });
  if (route.message !== '0x') params.set('message', route.message);
  return params;
}

async function suggestedFees(api: string, params: URLSearchParams, fetchFn: typeof fetch): Promise<AcrossFees> {
  const response = await fetchFn(`${api.replace(/\/$/, '')}/suggested-fees?${params}`);
  const body = (await response.json()) as AcrossFees & { message?: string };
  if (!response.ok) throw new Error(`Across would not quote: ${body.message ?? response.status}`);
  if (body.isAmountTooLow) throw new Error('Across will not bridge an amount this small.');
  return body;
}

function quoteFrom(body: AcrossFees, outputAmount: bigint): BridgeQuote {
  return {
    outputAmount,
    quoteTimestamp: Number(body.timestamp),
    fillDeadline: Number(body.fillDeadline),
    exclusiveRelayer: body.exclusiveRelayer,
    exclusivityParameter: Number(body.exclusivityDeadline),
  };
}

/** The part of the suggested-fees answer read here. */
interface AcrossFees {
  totalRelayFee: { total: string };
  timestamp: string;
  fillDeadline: string;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  isAmountTooLow?: boolean;
}

/** How long a deposit waits for a fill when there is no API to say. */
export const LOCAL_FILL_SECONDS = 60 * 60;

/**
 * A quote with no fee, for a local stack whose SpokePools are mocks that
 * `npm run dev:fork` fills. `now` is the origin chain's latest block time,
 * which the pool checks the quote against.
 */
export function localQuote(outputAmount: bigint, now: number): { inputAmount: bigint; quote: BridgeQuote } {
  return {
    inputAmount: outputAmount,
    quote: {
      outputAmount,
      quoteTimestamp: now,
      fillDeadline: now + LOCAL_FILL_SECONDS,
      exclusiveRelayer: '0x0000000000000000000000000000000000000000',
      exclusivityParameter: 0,
    },
  };
}

/** `SpokeRouter.joinMessage`: what a join tells `BridgeJoinReceiver`. */
export function joinMessage(matchId: Hex, player: Address, originChainId: number): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint32' }],
    [matchId, player, originChainId],
  );
}
