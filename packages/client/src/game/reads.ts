import { Action, addressKey, type RoundRecord } from '@lms/consensus';
import { favouriteTarget, tallySeat, type PlayStyle } from '@lms/api';
import { describeStyle } from './style.js';

/**
 * What a read is computed from: the seats and the published rounds. A live
 * `PublicMatchState` is one, and so is a replayed match.
 */
export interface ReadTable {
  players: ReadonlyArray<{ index: number; address: `0x${string}`; alive: boolean }>;
  history: readonly RoundRecord[];
}

export interface Read {
  seat: number;
  alive: boolean;
  strikes: number;
  guards: number;
  charges: number;
  noShows: number;
  /** Seat this player struck most often, or null if they never struck. */
  favourite: number | null;
  /** How many times they came after you. */
  againstYou: number;
  /** Short human-readable pattern, empty when nothing stands out. */
  tell: string;
  /** Their record from earlier settled matches, empty for a stranger. */
  past: string;
}

/**
 * Turns the public history into per-opponent tendencies.
 *
 * This is the whole point of the game: every move is eventually published, so
 * the edge does not come from hidden information but from noticing a pattern
 * before the table does. The client derives these purely from the same history
 * everyone sees — nothing here is privileged, it is just bookkeeping the player
 * would otherwise do on paper.
 */
export function readOpponents(
  state: ReadTable,
  you: number | null,
  dossier: ReadonlyMap<string, PlayStyle> = new Map(),
): Read[] {
  const reads = state.players
    .filter((player) => player.index !== you)
    .map((player): Read => {
      const { strikes, guards, charges, noShows, targets } = tallySeat(state.history, player.index);
      const favourite = favouriteTarget(targets);
      const read: Read = {
        seat: player.index,
        alive: player.alive,
        strikes,
        guards,
        charges,
        noShows,
        favourite: favourite?.seat ?? null,
        againstYou: you === null ? 0 : (targets.get(you) ?? 0),
        tell: '',
        past: describeStyle(dossier.get(addressKey(player.address))),
      };
      read.tell = tellFor(read, leaderHunts(state.history, player.index), favourite?.hits ?? 0, you);
      return read;
    });
  return reads.sort((a, b) => Number(b.alive) - Number(a.alive) || a.seat - b.seat);
}

/** How many of `seat`'s strikes went to a seat on top of the table at the time. */
function leaderHunts(history: readonly RoundRecord[], seat: number): number {
  let hunts = 0;
  for (const [index, record] of history.entries()) {
    const move = record.moves.find((entry) => entry.index === seat);
    if (move?.revealed && move.action === Action.Strike && hpLeaders(record, history[index - 1]).has(move.target)) {
      hunts += 1;
    }
  }
  return hunts;
}

/**
 * Seats that were on top *going into* the round, which is the information an
 * opponent actually had when they chose their target.
 */
function hpLeaders(record: RoundRecord, previous: RoundRecord | undefined): Set<number> {
  const hp = previous?.hpAfter;
  if (!hp) return new Set(record.moves.map((move) => move.index));

  let top = -Infinity;
  for (const move of record.moves) {
    const value = hp[move.index] ?? 0;
    if (value > top) top = value;
  }
  return new Set(record.moves.filter((move) => (hp[move.index] ?? 0) === top).map((m) => m.index));
}

/** `favouriteHits`: how many of the seat's strikes went to its favourite target. */
function tellFor(read: Read, leaderHunts: number, favouriteHits: number, you: number | null): string {
  const revealed = read.strikes + read.guards + read.charges;
  // Two rounds is noise; three is the point where a habit is worth naming.
  if (revealed < 3) return '';

  if (you !== null && read.againstYou >= 2) return `has a grudge on you (${read.againstYou}×)`;
  if (leaderHunts >= 2 && leaderHunts / Math.max(read.strikes, 1) >= 0.6) return 'hunts the leader';
  if (read.strikes / revealed >= 0.7) return 'always swings';
  // Guard and Charge cannot repeat, so every other round is the ceiling.
  if (read.guards / revealed >= 0.45) return 'guards every chance it gets';
  if (read.charges / revealed >= 0.4) return 'loves the big swing';
  if (read.noShows >= 2) return 'keeps timing out';
  if (read.favourite !== null && favouriteHits >= 3) return `fixated on #${read.favourite}`;
  return '';
}
