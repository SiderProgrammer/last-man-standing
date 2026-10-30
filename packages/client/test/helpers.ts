import { keccak256, toHex } from 'viem';
import {
  Action,
  DEFAULT_RULES,
  MatchPhase,
  type ActionValue,
  type PublicMatchState,
  type RoundRecord,
  ZERO_SALT,
} from '@lms/protocol';

export function bytes32(label: string): `0x${string}` {
  return keccak256(toHex(label));
}

export interface MoveSpec {
  index: number;
  action: ActionValue;
  target?: number;
  revealed?: boolean;
}

/**
 * A round record carrying only what the reads panel looks at: the declared
 * moves and the HP the round left behind. Strikes and the stall penalty are not
 * read by `readOpponents`, so they stay empty rather than pretending to be
 * consistent with the moves.
 */
export function round(number: number, moves: MoveSpec[], hpAfter: number[]): RoundRecord {
  return {
    round: number,
    moves: moves.map((move) => ({
      index: move.index,
      action: move.action,
      target: move.target ?? 0,
      revealed: move.revealed ?? true,
      salt: ZERO_SALT,
    })),
    strikes: [],
    stallDamage: 0,
    eliminated: [],
    hpAfter,
    hash: bytes32(`round:${number}`),
  };
}

export function stateWith(
  seatCount: number,
  history: RoundRecord[],
  dead: number[] = [],
): PublicMatchState {
  return {
    matchId: bytes32('match'),
    seed: bytes32('seed'),
    rules: DEFAULT_RULES,
    phase: MatchPhase.Commit,
    round: history.length + 1,
    players: Array.from({ length: seatCount }, (_, index) => ({
      index,
      address: `0x${(index + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
      chainId: 11155111,
      hp: dead.includes(index) ? 0 : 100,
      alive: !dead.includes(index),
      charged: false,
      lastAction: Action.None,
    })),
    committed: [],
    commitments: [],
    revealed: [],
    history,
    historyRoot: bytes32('root'),
  };
}
