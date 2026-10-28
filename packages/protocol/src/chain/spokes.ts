import { parseAbi } from 'viem';

/**
 * Joining a hub lobby from a spoke chain.
 *
 * A player on a spoke stakes into `SpokeEscrow` there; the messenger carries
 * the stake and the join to the hub, which seats the player or, if the seat
 * is gone by the time it lands, credits the stake back to them on the hub.
 * Shared because the server watches the hub end and the client drives the
 * spoke end, and both have to agree with the deployed contracts.
 */

/** The `SpokeEscrow` surface the client calls. */
export const spokeEscrowAbi = parseAbi([
  'function quoteJoin(bytes32 matchId, uint128 stake) view returns (uint256)',
  'function join(bytes32 matchId, uint128 stake) payable',
  'function hubChainId() view returns (uint32)',
  'function hubEscrow() view returns (bytes32)',
  'event JoinForwarded(bytes32 indexed matchId, address indexed player, uint128 stake)',
  'error InsufficientValue(uint256 sent, uint256 required)',
  // Raised through `quoteJoin` by LayerZero's executor when the stake is
  // more native value than it will deliver to the hub in one message.
  'error Executor_NativeAmountExceedsCap(uint256 amount, uint256 cap)',
]);

/** The hub `LayerZeroMessenger`: its parked deliveries, and their retry. */
export const layerZeroMessengerAbi = parseAbi([
  'function retry(bytes32 guid, uint32 srcChainId, bytes32 srcApp, bytes payload, uint256 value)',
  'function parked(bytes32 guid) view returns (bytes32)',
  'function totalParked() view returns (uint256)',
  'function setPeer(uint32 chainId, uint32 eid, bytes32 peer)',
  'function setApp(address app)',
  'function setDelegate(address delegate)',
  'function setReceiveGas(uint128 gas)',
  'event DeliveryParked(bytes32 indexed guid, uint32 srcChainId, bytes32 srcApp, bytes payload, uint256 value, bytes reason)',
  'event DeliveryRetried(bytes32 indexed guid)',
]);

/** A spoke the server advertises: where a player on that chain stakes. */
export interface SpokeInfo {
  chainId: number;
  /** `SpokeEscrow` on that chain. */
  escrow: `0x${string}`;
}

/** Mirrors `GameEscrow.JoinFailure`: why a cross-chain stake was refunded instead of seated. */
export const JoinFailure = {
  None: 0,
  Paused: 1,
  UnknownMatch: 2,
  NotOpen: 3,
  WindowClosed: 4,
  LobbyFull: 5,
  AlreadyJoined: 6,
  WrongStake: 7,
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
    case JoinFailure.WrongStake:
      return 'the stake did not match the lobby';
    default:
      return 'the seat could not be taken';
  }
}

/**
 * What happened to a cross-chain join once it reached the hub, as the server
 * reports it to the player it belongs to.
 *
 *   - `seated`: the stake took a seat.
 *   - `refunded`: the seat was gone; the stake is the player's on the hub, to
 *     collect like any other balance.
 *   - `parked`: the hub could not take the delivery at all — a route not yet
 *     registered, say — so the messenger holds the stake until it can be
 *     retried. Nothing is lost; it is waiting on the operator or governance.
 *
 * `amount` is in wei, as a decimal string so it survives JSON.
 */
export type CrossChainEvent =
  | { kind: 'seated'; matchId: `0x${string}`; chainId: number }
  | { kind: 'refunded'; matchId: `0x${string}`; amount: string; reason: number }
  | { kind: 'parked'; matchId: `0x${string}`; amount: string };
