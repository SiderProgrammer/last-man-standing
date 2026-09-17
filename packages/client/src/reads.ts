import { Action, type PublicMatchState, type RoundRecord } from '@lms/protocol';

export interface Read {
  seat: number;
  alive: boolean;
  attacks: number;
  defends: number;
  hides: number;
  noShows: number;
  /** Seat this player attacked most often, or null if they never attacked. */
  favourite: number | null;
  /** How many times they came after you. */
  againstYou: number;
  /** Short human-readable pattern, empty when nothing stands out. */
  tell: string;
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
export function readOpponents(state: PublicMatchState, you: number | null): Read[] {
  const reads = new Map<number, Read>();

  for (const player of state.players) {
    if (player.index === you) continue;
    reads.set(player.index, {
      seat: player.index,
      alive: player.alive,
      attacks: 0,
      defends: 0,
      hides: 0,
      noShows: 0,
      favourite: null,
      againstYou: 0,
      tell: '',
    });
  }

  const targetCounts = new Map<number, Map<number, number>>();
  const leaderHunts = new Map<number, number>();

  for (const record of state.history) {
    const leaders = hpLeaders(state, record);
    for (const move of record.moves) {
      const read = reads.get(move.index);
      if (!read) continue;

      if (!move.revealed) {
        read.noShows += 1;
        continue;
      }

      if (move.action === Action.Defend) read.defends += 1;
      else if (move.action === Action.Hide) read.hides += 1;
      else if (move.action === Action.Attack) {
        read.attacks += 1;
        if (move.target === you) read.againstYou += 1;
        if (leaders.has(move.target)) {
          leaderHunts.set(move.index, (leaderHunts.get(move.index) ?? 0) + 1);
        }
        const counts = targetCounts.get(move.index) ?? new Map<number, number>();
        counts.set(move.target, (counts.get(move.target) ?? 0) + 1);
        targetCounts.set(move.index, counts);
      }
    }
  }

  for (const read of reads.values()) {
    const counts = targetCounts.get(read.seat);
    if (counts) {
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (best) read.favourite = best[0];
    }
    read.tell = tellFor(read, leaderHunts.get(read.seat) ?? 0, you);
  }

  return [...reads.values()].sort((a, b) => Number(b.alive) - Number(a.alive) || a.seat - b.seat);
}

/**
 * Seats that were on top *going into* the round, which is the information an
 * opponent actually had when they chose their target.
 */
function hpLeaders(state: PublicMatchState, record: RoundRecord): Set<number> {
  const index = state.history.indexOf(record);
  const previous = index > 0 ? state.history[index - 1] : undefined;
  const hp = previous?.hpAfter;
  if (!hp) return new Set(record.moves.map((move) => move.index));

  let top = -Infinity;
  for (const move of record.moves) {
    const value = hp[move.index] ?? 0;
    if (value > top) top = value;
  }
  return new Set(record.moves.filter((move) => (hp[move.index] ?? 0) === top).map((m) => m.index));
}

function tellFor(read: Read, leaderHunts: number, you: number | null): string {
  const revealed = read.attacks + read.defends + read.hides;
  // Two rounds is noise; three is the point where a habit is worth naming.
  if (revealed < 3) return '';

  if (you !== null && read.againstYou >= 2) return `has a grudge on you (${read.againstYou}×)`;
  if (leaderHunts >= 2 && leaderHunts / Math.max(read.attacks, 1) >= 0.6) return 'hunts the leader';
  if (read.attacks / revealed >= 0.7) return 'always swings';
  if (read.defends / revealed >= 0.5) return 'turtles';
  if (read.hides / revealed >= 0.5) return 'ghosts the round';
  if (read.noShows >= 2) return 'keeps timing out';
  if (read.favourite !== null && (read.attacks >= 3 || revealed >= 5)) {
    const counts = read.attacks;
    if (counts >= 3) return `fixated on #${read.favourite}`;
  }
  return '';
}
