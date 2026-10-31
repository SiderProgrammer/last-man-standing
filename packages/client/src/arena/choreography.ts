import {
  StrikeOutcome,
  type ActionValue,
  type RoundRecord,
  type StrikeOutcomeValue,
} from '@lms/consensus';

/**
 * A resolved round, turned into a schedule of beats: what happens, to whom, and
 * when. It decides nothing about how any of it moves — `replay.ts` turns this
 * schedule into a GSAP timeline, and GSAP does the interpolation.
 *
 * Pure: no Pixi, no clock, no canvas. Everything here is derived from the
 * published `RoundRecord`, which is the only source a spectator has too, so the
 * replay can never show anything the history feed does not.
 *
 * HP is moved between two waypoints and deliberately knows no rule constants:
 *
 *   before → afterStrikes   exact from the record: damage taken as a target,
 *                           reflections taken as a striker, and heals gained
 *                           from landed hits, capped at `maxHp`
 *   afterStrikes → hpAfter  whatever the stall penalty and the engine's
 *                           survivor rule did, landing on the *published* value
 *
 * Ending on `hpAfter` rather than on our own arithmetic is what keeps the
 * replay honest when the engine does something the client cannot reconstruct —
 * the last player standing surviving on 1 HP after a round that should have
 * killed everyone, for example.
 */

/** One seat as it stood before the round resolved. */
export interface SeatSnapshot {
  index: number;
  hp: number;
  alive: boolean;
}

export type Beat =
  /** A seat shows the move it revealed: a lunge, a raised shield, a charge-up. */
  | { kind: 'declare'; seat: number; action: ActionValue; target: number; start: number; end: number }
  /** A seat that never revealed, and is resolved as having done nothing. */
  | { kind: 'noShow'; seat: number; start: number; end: number }
  /** A projectile on its way from striker to target. */
  | { kind: 'travel'; from: number; to: number; outcome: StrikeOutcomeValue; charged: boolean; start: number; end: number }
  /** The projectile arriving, and what the target did about it. */
  | {
      kind: 'impact';
      seat: number;
      from: number;
      outcome: StrikeOutcomeValue;
      charged: boolean;
      damage: number;
      start: number;
      end: number;
    }
  /** A guard's reflected damage flying back at the striker. */
  | { kind: 'reflect'; from: number; to: number; damage: number; start: number; end: number }
  /** A striker drawing HP back from a hit that landed. */
  | { kind: 'heal'; seat: number; amount: number; start: number; end: number }
  /** The stall penalty biting one seat. `damage` is the HP the seat visibly loses. */
  | { kind: 'stall'; seat: number; damage: number; start: number; end: number }
  /** A seat shattering. `order` is its place in the record's tie-broken order. */
  | { kind: 'eliminate'; seat: number; order: number; start: number; end: number };

export interface Window {
  start: number;
  end: number;
}

export interface SeatTrack {
  before: number;
  afterStrikes: number;
  after: number;
  aliveBefore: boolean;
  strikeWindow: Window | null;
  settleWindow: Window | null;
  eliminateWindow: Window | null;
}

export interface Timeline {
  beats: Beat[];
  /** Seconds from the first beat starting to the last one ending. */
  duration: number;
  /** When the stall penalty bit this round, so the wall should flare. */
  stall: Window | null;
  tracks: Map<number, SeatTrack>;
}

// Timings, in seconds. Tuned so the worst case — eight seats, every one of them
// striking, several dying — still ends inside the server's default replay
// hold of 2.5s. `choreography.test.ts` holds this to account.
const DECLARE = 0.25;
const TRAVEL = 0.35;
/** Total spread of strike launches, however many strikes there are. */
const TRAVEL_SPREAD = 0.2;
const MAX_TRAVEL_STAGGER = 0.06;
const IMPACT = 0.35;
const REFLECT = 0.25;
const HEAL = 0.25;
/** How long an HP arc takes to drain after a blow lands. */
const DRAIN = 0.2;
const GAP = 0.05;
const SETTLE = 0.3;
const ELIMINATE = 0.45;
const ELIMINATE_SPREAD = 0.15;
const MAX_ELIMINATE_STAGGER = 0.1;

/** Even spacing across a fixed spread, capped so a few events do not crawl. */
function stagger(count: number, spread: number, cap: number): number {
  return count > 1 ? Math.min(cap, spread / (count - 1)) : 0;
}

/**
 * `maxHp` is the cap healing cannot pass. It is the only rule the replay needs
 * up front: without it a full-HP striker's heal would overfill the arc for a
 * moment before the settle pulled it back.
 */
export function choreograph(record: RoundRecord, before: readonly SeatSnapshot[], maxHp = Infinity): Timeline {
  const beats: Beat[] = [];
  const snapshot = new Map(before.map((seat) => [seat.index, seat]));

  // --- Declare ---------------------------------------------------------------
  for (const move of record.moves) {
    if (!move.revealed) {
      beats.push({ kind: 'noShow', seat: move.index, start: 0, end: DECLARE });
      continue;
    }
    beats.push({
      kind: 'declare',
      seat: move.index,
      action: move.action,
      target: move.target,
      start: 0,
      end: DECLARE,
    });
  }

  // --- Travel, impact, reflect, heal --------------------------------------------
  // Every strike resolves against the start-of-round state at once; the stagger
  // is purely so eight simultaneous bolts stay individually readable.
  const strikes = record.strikes.filter((strike) => strike.outcome !== StrikeOutcome.Void);
  const travelStep = stagger(strikes.length, TRAVEL_SPREAD, MAX_TRAVEL_STAGGER);
  /** Net HP each seat loses in the combat phase; negative for a net heal. */
  const net = new Map<number, number>();
  /** When each seat's HP is seen to move during the combat phase. */
  const landings = new Map<number, number[]>();
  const land = (seat: number, at: number, amount: number) => {
    if (amount === 0) return;
    net.set(seat, (net.get(seat) ?? 0) + amount);
    landings.set(seat, [...(landings.get(seat) ?? []), at]);
  };

  strikes.forEach((strike, position) => {
    const start = DECLARE + position * travelStep;
    const arrive = start + TRAVEL;
    beats.push({
      kind: 'travel',
      from: strike.striker,
      to: strike.target,
      outcome: strike.outcome,
      charged: strike.charged,
      start,
      end: arrive,
    });
    beats.push({
      kind: 'impact',
      seat: strike.target,
      from: strike.striker,
      outcome: strike.outcome,
      charged: strike.charged,
      damage: strike.damage,
      start: arrive,
      end: arrive + IMPACT,
    });
    land(strike.target, arrive, strike.damage);

    if (strike.heal > 0) {
      beats.push({ kind: 'heal', seat: strike.striker, amount: strike.heal, start: arrive, end: arrive + HEAL });
      land(strike.striker, arrive + HEAL, -strike.heal);
    }

    if (strike.outcome === StrikeOutcome.Guarded && strike.reflected > 0) {
      beats.push({
        kind: 'reflect',
        from: strike.target,
        to: strike.striker,
        damage: strike.reflected,
        start: arrive,
        end: arrive + REFLECT,
      });
      land(strike.striker, arrive + REFLECT, strike.reflected);
    }
  });

  const combatEnd = Math.max(
    DECLARE,
    ...beats.map((beat) => beat.end),
    ...[...landings.values()].flat().map((at) => at + DRAIN),
  );

  // --- Tracks ------------------------------------------------------------------
  const tracks = new Map<number, SeatTrack>();
  const seats = new Set<number>([
    ...before.map((seat) => seat.index),
    ...record.hpAfter.map((_, index) => index),
  ]);

  for (const index of seats) {
    const seat = snapshot.get(index);
    const start = seat?.hp ?? record.hpAfter[index] ?? 0;
    const after = record.hpAfter[index] ?? start;
    const times = landings.get(index) ?? [];
    tracks.set(index, {
      before: start,
      // Clamped: the engine lets HP run negative to rank overkill, but an arc
      // cannot drain below empty, and healing stops at the cap.
      afterStrikes: Math.max(0, Math.min(Math.max(start, maxHp), start - (net.get(index) ?? 0))),
      after,
      aliveBefore: seat?.alive ?? after > 0,
      strikeWindow:
        times.length > 0 ? { start: Math.min(...times), end: Math.max(...times) + DRAIN } : null,
      settleWindow: null,
      eliminateWindow: null,
    });
  }

  // --- Stall penalty, and anything else that moved HP after the strikes -------
  const settling = [...tracks.values()].some((track) => track.afterStrikes !== track.after);
  const settleWindow: Window | null =
    record.stallDamage > 0 || settling
      ? { start: combatEnd + GAP, end: combatEnd + GAP + SETTLE }
      : null;

  if (settleWindow) {
    for (const [index, track] of tracks) {
      if (!track.aliveBefore) continue;
      track.settleWindow = settleWindow;
      const loss = track.afterStrikes - track.after;
      if (record.stallDamage > 0 && loss > 0) {
        beats.push({ kind: 'stall', seat: index, damage: loss, ...settleWindow });
      }
    }
  }

  // --- Eliminate -----------------------------------------------------------------
  const eliminateFrom = (settleWindow?.end ?? combatEnd) + GAP;
  const eliminateStep = stagger(record.eliminated.length, ELIMINATE_SPREAD, MAX_ELIMINATE_STAGGER);
  record.eliminated.forEach((seat, order) => {
    const start = eliminateFrom + order * eliminateStep;
    const window = { start, end: start + ELIMINATE };
    beats.push({ kind: 'eliminate', seat, order, ...window });
    const track = tracks.get(seat);
    if (track) track.eliminateWindow = window;
  });

  return {
    beats,
    duration: Math.max(DECLARE, ...beats.map((beat) => beat.end)),
    stall: record.stallDamage > 0 ? settleWindow : null,
    tracks,
  };
}
