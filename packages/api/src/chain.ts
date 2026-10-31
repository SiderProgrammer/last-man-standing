import type { Address, Hex } from 'viem';
import type { ChainWithdrawal } from '@lms/consensus';
import type { BridgeQuote } from '@lms/contracts';

/**
 * What the server tells a client about the chains it serves, and what crosses
 * the wire about a player's stakes and payouts. Amounts are decimal strings,
 * so they survive JSON.
 */

/** A spoke the server advertises: where a player on that chain stakes. */
export interface SpokeInfo {
  chainId: number;
  /** `SpokeRouter` on that chain. */
  router: `0x${string}`;
}

/**
 * What happened to a cross-chain join once it reached the hub, as the server
 * reports it to the player it belongs to.
 *
 *   - `seated`: the stake took a seat.
 *   - `refunded`: the seat was gone; the stake is the player's on the hub, to
 *     collect like any other balance.
 *
 * `amount` is in wei, as a decimal string so it survives JSON.
 */
export type CrossChainEvent =
  | { kind: 'seated'; matchId: `0x${string}`; chainId: number }
  | { kind: 'refunded'; matchId: `0x${string}`; amount: string; reason: number };

/** What the client needs to show the staking panel, sent in `hello`. */
export interface StakingInfo {
  /** `StakedLms` on the hub chain. The LMS token is its `underlying()`. */
  vault: `0x${string}`;
  /** `LmsGovernor`, or null when this server indexes no proposals. */
  governor: `0x${string}` | null;
  /** `FeeRouter`, so proposals that change it are labelled. Null when there is none. */
  feeRouter: `0x${string}` | null;
  /**
   * `RewardsDistributor`, for claiming play-mining rewards. Optional for older
   * servers; absent or null hides the claim.
   */
  rewards?: `0x${string}` | null;
}

/**
 * One hop of a route, in v4-periphery's exact-output `PathKey` convention:
 * ordered from the token the player pays towards ETH, each entry names the
 * currency *entering* that hop and the pool it trades through. So `path[0]` is
 * always the token itself, and the last hop's pool pairs with native ETH.
 *
 * `fee` and `tickSpacing` are numbers rather than bigints so the whole route
 * survives `JSON.stringify` on its way through the socket.
 */
export interface ZapPathKey {
  intermediateCurrency: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  hookData: `0x${string}`;
}

/** A token the server offers as payment, with its route to ETH. */
export interface ZapToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  path: ZapPathKey[];
}

/** What the client needs to offer token payment at all. */
export interface ZapInfo {
  /** `ZapJoin` on the hub chain. */
  address: `0x${string}`;
  /** v4-periphery `V4Quoter` on the hub chain, for pricing a route before paying. */
  quoter: `0x${string}`;
  tokens: ZapToken[];
}

/**
 * The avatar a seat is wearing.
 *
 * This travels beside `PublicMatchState` rather than inside it: an avatar is
 * cosmetic, and the engine that produces the match snapshot must not know it
 * exists. Nothing here reaches the commit hash, the round hashes or the
 * history root, so a replay is identical with or without avatars.
 */
export interface AvatarEntry {
  seat: number;
  /** Token id as a decimal string, because it is a `uint256`. */
  tokenId: string;
  /** Chain the collection lives on — the same chain the seat staked from. */
  chainId: number;
  /**
   * Resolved image URL, already rewritten from `ipfs://` to a gateway.
   * Null when the metadata could not be read: the seat then falls back to its
   * plain circle and the match is unaffected.
   */
  image: string | null;
}

/** A call a session key signed, as it crosses the wire. Amounts in decimal wei. */
export interface RelayedCall {
  target: Address;
  value: string;
  data: Hex;
  nonce: string;
  signature: Hex;
}

/** `ChainWithdrawal` over the wire: every number a decimal string. */
export type WireWithdrawal = { [K in keyof ChainWithdrawal]: ChainWithdrawal[K] extends bigint ? string : ChainWithdrawal[K] };

/** `BridgeQuote` over the wire, its amount a decimal string. */
export type WireBridgeQuote = Omit<BridgeQuote, 'outputAmount'> & { outputAmount: string };

export function withdrawalToWire(w: ChainWithdrawal): WireWithdrawal {
  return {
    player: w.player,
    hubChainId: w.hubChainId.toString(),
    destinationChainId: w.destinationChainId.toString(),
    recipient: w.recipient,
    outputToken: w.outputToken,
    maxFee: w.maxFee.toString(),
    nonce: w.nonce.toString(),
    deadline: w.deadline.toString(),
  };
}

export function withdrawalFromWire(w: WireWithdrawal): ChainWithdrawal {
  return {
    player: w.player,
    hubChainId: BigInt(w.hubChainId),
    destinationChainId: BigInt(w.destinationChainId),
    recipient: w.recipient,
    outputToken: w.outputToken,
    maxFee: BigInt(w.maxFee),
    nonce: BigInt(w.nonce),
    deadline: BigInt(w.deadline),
  };
}

export function quoteToWire(quote: BridgeQuote): WireBridgeQuote {
  return { ...quote, outputAmount: quote.outputAmount.toString() };
}

export function quoteFromWire(quote: WireBridgeQuote): BridgeQuote {
  return { ...quote, outputAmount: BigInt(quote.outputAmount) };
}
