import {
  AttackOutcome,
  type ActionValue,
  type AttackOutcomeValue,
  type RoundRecord,
} from '@lms/protocol';

/**
 * A resolved round, turned into a timeline the arena can play back.
 *
 * Pure: no Pixi, no clock, no canvas — the arena asks `sample(timeline, t)` what
 * each seat should look like at time `t` and draws that. Everything here is
 * derived from the published `RoundRecord`, which is the only source a spectator
 * has too, so the replay can never show anything the history feed does not.
 *
 * HP is moved between two waypoints and deliberately knows no rule constants:
 *
 *   before → afterAttacks   exact from the record: damage taken as a target and
 *                           riposte taken as an attacker
 *   afterAttacks → hpAfter  whatever the storm and the engine's survivor rule
 *                           did, landing on the *published* value
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
  /** A seat shows the move it revealed: a lunge, a raised shield, a shimmer. */
  | { kind: 'declare'; seat: number; action: ActionValue; target: number; start: number; end: number }
  /** A seat that never revealed, and is resolved as a weaker Hide. */
  | { kind: 'noShow'; seat: number; start: number; end: number }
  /** A projectile on its way from attacker to target. */
  | { kind: 'travel'; from: number; to: number; outcome: AttackOutcomeValue; start: number; end: number }
  /** The projectile arriving, and what the target did about it. */
  | {
      kind: 'impact';
      seat: number;
      from: number;
      outcome: AttackOutcomeValue;
      damage: number;
      start: number;
      end: number;
    }
  /** A defender's reflected damage flying back at the attacker. */
  | { kind: 'riposte'; from: number; to: number; damage: number; start: number; end: number }
  /** The storm biting one seat. `damage` is the HP the seat visibly loses. */
  | { kind: 'storm'; seat: number; damage: number; start: number; end: number }
  /** A seat shattering. `order` is its place in the record's tie-broken order. */
  | { kind: 'eliminate'; seat: number; order: number; start: number; end: number };

interface Window {
  start: number;
  end: number;
}

interface SeatTrack {
  before: number;
  afterAttacks: number;
  after: number;
  aliveBefore: boolean;
  attackWindow: Window | null;
  settleWindow: Window | null;
  eliminateWindow: Window | null;
}

export interface Timeline {
  beats: Beat[];
  /** Seconds from the first beat starting to the last one ending. */
  duration: number;
  /** True when the storm did damage this round, so the ring should flare. */
  storm: Window | null;
  tracks: Map<number, SeatTrack>;
}

export interface SeatDisplay {
  hp: number;
  alive: boolean;
  /** 0 until the seat's elimination beat starts, 1 once it has finished. */
  dying: number;
}

// Timings, in seconds. Tuned so the worst case — eight seats, every one of them
// attacking, several dying — still ends inside the server's default replay
// hold of 2.5s. `choreography.test.ts` holds this to account.
const DECLARE = 0.25;
const TRAVEL = 0.35;
/** Total spread of attack launches, however many attacks there are. */
const TRAVEL_SPREAD = 0.2;
const MAX_TRAVEL_STAGGER = 0.06;
const IMPACT = 0.35;
const RIPOSTE = 0.25;
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

export function choreograph(record: RoundRecord, before: readonly SeatSnapshot[]): Timeline {
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

  // --- Travel, impact, riposte ----------------------------------------------
  // Every attack resolves against the start-of-round state at once; the stagger
  // is purely so eight simultaneous bolts stay individually readable.
  const attacks = record.attacks.filter((attack) => attack.outcome !== AttackOutcome.Void);
  const travelStep = stagger(attacks.length, TRAVEL_SPREAD, MAX_TRAVEL_STAGGER);
  const incoming = new Map<number, number>();
  /** When each seat's HP is seen to drop during the combat phase. */
  const landings = new Map<number, number[]>();
  const land = (seat: number, at: number, amount: number) => {
    if (amount <= 0) return;
    incoming.set(seat, (incoming.get(seat) ?? 0) + amount);
    landings.set(seat, [...(landings.get(seat) ?? []), at]);
  };

  attacks.forEach((attack, position) => {
    const start = DECLARE + position * travelStep;
    const arrive = start + TRAVEL;
    beats.push({
      kind: 'travel',
      from: attack.attacker,
      to: attack.target,
      outcome: attack.outcome,
      start,
      end: arrive,
    });
    beats.push({
      kind: 'impact',
      seat: attack.target,
      from: attack.attacker,
      outcome: attack.outcome,
      damage: attack.damage,
      start: arrive,
      end: arrive + IMPACT,
    });
    land(attack.target, arrive, attack.damage);

    if (attack.outcome === AttackOutcome.Parried && attack.riposte > 0) {
      beats.push({
        kind: 'riposte',
        from: attack.target,
        to: attack.attacker,
        damage: attack.riposte,
        start: arrive,
        end: arrive + RIPOSTE,
      });
      land(attack.attacker, arrive + RIPOSTE, attack.riposte);
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
      // cannot drain below empty.
      afterAttacks: Math.max(0, start - (incoming.get(index) ?? 0)),
      after,
      aliveBefore: seat?.alive ?? after > 0,
      attackWindow:
        times.length > 0 ? { start: Math.min(...times), end: Math.max(...times) + DRAIN } : null,
      settleWindow: null,
      eliminateWindow: null,
    });
  }

  // --- Storm, and anything else that moved HP after the attacks ----------------
  const settling = [...tracks.values()].some((track) => track.afterAttacks !== track.after);
  const settleWindow: Window | null =
    record.stormDamage > 0 || settling
      ? { start: combatEnd + GAP, end: combatEnd + GAP + SETTLE }
      : null;

  if (settleWindow) {
    for (const [index, track] of tracks) {
      if (!track.aliveBefore) continue;
      track.settleWindow = settleWindow;
      const loss = track.afterAttacks - track.after;
      if (record.stormDamage > 0 && loss > 0) {
        beats.push({ kind: 'storm', seat: index, damage: loss, ...settleWindow });
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
    storm: record.stormDamage > 0 ? settleWindow : null,
    tracks,
  };
}

/** Progress through a window, 0 before it and 1 after it. */
export function progress(t: number, window: Window): number {
  if (t <= window.start) return 0;
  if (t >= window.end) return 1;
  return (t - window.start) / (window.end - window.start);
}

/** Fast at first, settling gently: how a draining bar reads as a hit. */
export function easeOutCubic(x: number): number {
  return 1 - (1 - x) ** 3;
}

function move(from: number, to: number, window: Window | null, t: number): number {
  if (!window) return to;
  const p = progress(t, window);
  // Returned exactly rather than interpolated at the end, so a finished replay
  // shows the published integer and not a float one ulp away from it.
  if (p >= 1) return to;
  return from + (to - from) * easeOutCubic(p);
}

/** What every seat should display `t` seconds into the replay. */
export function sample(timeline: Timeline, t: number): Map<number, SeatDisplay> {
  const out = new Map<number, SeatDisplay>();

  for (const [index, track] of timeline.tracks) {
    // Untouched by any blow, `before` and `afterAttacks` are the same number.
    let hp = track.attackWindow
      ? t < track.attackWindow.start
        ? track.before
        : move(track.before, track.afterAttacks, track.attackWindow, t)
      : track.afterAttacks;
    if (track.settleWindow && t >= track.settleWindow.start) {
      hp = move(track.afterAttacks, track.after, track.settleWindow, t);
    }
    // No settle beat for this seat means its attack waypoint already is final.
    if (!track.settleWindow && (!track.attackWindow || t >= track.attackWindow.end)) {
      hp = track.after;
    }

    const dying = track.eliminateWindow ? progress(t, track.eliminateWindow) : 0;
    out.set(index, {
      hp,
      // A seat stays "alive" on screen until its shatter has played out, so the
      // fade to the dead style happens at the end of the beat, not the start.
      alive: track.aliveBefore && dying < 1,
      dying,
    });
  }

  return out;
}
