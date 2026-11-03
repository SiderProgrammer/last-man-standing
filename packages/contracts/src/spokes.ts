import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { ZERO_ADDRESS } from '@lms/consensus';
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

const JOIN_FAILURE_TEXT: Readonly<Record<number, string>> = {
  [JoinFailure.Paused]: 'play was paused',
  [JoinFailure.UnknownMatch]: 'the hub does not know that lobby',
  [JoinFailure.NotOpen]: 'the lobby had already closed',
  [JoinFailure.WindowClosed]: 'the join window ended while your stake was in transit',
  [JoinFailure.LobbyFull]: 'the lobby filled while your stake was in transit',
  [JoinFailure.AlreadyJoined]: 'you already had a seat in it',
  [JoinFailure.StakeTooLow]: 'less than the stake arrived',
  [JoinFailure.NotRostered]: 'that lobby was matched for other players',
};

/** Why the hub refunded a join, as the player should read it. */
export function joinFailureText(reason: number): string {
  return JOIN_FAILURE_TEXT[reason] ?? 'the seat could not be taken';
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
  const body = await suggestedFees(api, feeParams(route, outputAmount), fetchFn);
  return { inputAmount: outputAmount + feeWithBuffer(body), quote: quoteFrom(body, outputAmount) };
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
  const outputAmount = inputAmount - feeWithBuffer(body);
  if (outputAmount <= 0n) throw new Error('Across would take all of it in fees.');
  return { outputAmount, quote: quoteFrom(body, outputAmount) };
}

/** The quoted fee, plus `FEE_BUFFER_BPS` of it rounded up: what the relayer is offered. */
function feeWithBuffer(body: AcrossFees): bigint {
  const fee = BigInt(body.totalRelayFee.total);
  return fee + (fee * FEE_BUFFER_BPS + 9_999n) / 10_000n;
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
      exclusiveRelayer: ZERO_ADDRESS,
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
