import {
  Action,
  ACTION_NAMES,
  draw,
  exposedDamage,
  isLegalAction,
  roundSeed,
  saltsBySeat,
  stallDamageFor,
  strikeDamageFor,
  strikeHeal,
  StrikeOutcome,
  ZERO_SALT,
  type ActionValue,
  type PlayerState,
  type RoundRecord,
  type Rules,
  type StrikeRecord,
} from '@lms/protocol';

/** A move as it enters resolution, after the reveal window has closed. */
export interface DeclaredMove {
  index: number;
  action: ActionValue;
  target: number;
  /** False when the player never revealed and was defaulted to `Action.None`. */
  revealed: boolean;
  /** Salt the move was revealed under; `ZERO_SALT` when it was not revealed. */
  salt: `0x${string}`;
}

export interface RoundResolution {
  record: Omit<RoundRecord, 'hash'>;
  /** Player states after the round, indexed by seat. */
  states: PlayerState[];
  /** Seats eliminated this round, ordered worst-placed first. */
  eliminationOrder: number[];
  /** Rounds in a row without a hit once this one is counted; feeds the next round. */
  quietRounds: number;
}

/**
 * Nonce space for a Guard's pick of which striker to block. Seats are below
 * 256 (`uint8`), so each draw kind gets its own block of 256 nonces.
 */
export const GUARD_NONCE_BASE = 256;
/** Nonce space for breaking HP ties between seats. */
export const TIEBREAK_NONCE_BASE = 512;

/**
 * A seat's tiebreak key for a round: lower wins the tie. Drawn from the round's
 * entropy rather than taken from the seat index, because seats are assigned in
 * join order and a fixed order would hand ties to whoever joined first.
 */
export function tiebreakKey(entropy: `0x${string}`, seat: number): bigint {
  return draw(entropy, TIEBREAK_NONCE_BASE + seat);
}

/** The entropy every roll of a round is drawn from, recomputed from its published record. */
export function entropyOf(
  seed: `0x${string}`,
  seats: number,
  record: Pick<RoundRecord, 'round' | 'moves'>,
): `0x${string}` {
  return roundSeed(seed, record.round, saltsBySeat(seats, record.moves));
}

/** Scratch state for one seat while a round is being resolved. */
interface SeatContext {
  readonly seat: number;
  readonly before: PlayerState;
  action: ActionValue;
  target: number;
  revealed: boolean;
  salt: `0x${string}`;
  /** Damage accumulated from strikes and reflections this round. */
  incoming: number;
  /** HP regained from landed strikes this round. */
  healing: number;
  /** Hit points after the round. Allowed to go negative to rank overkill. */
  hp: number;
}

/**
 * Resolves a single round.
 *
 * Pure and total: given the same rules, seed, round number, states, moves and
 * quiet-round count it always produces the same output, with no reliance on
 * the iteration order of the input moves, wall-clock time, or floating point.
 * This is what makes a match independently replayable from its seed and move
 * log.
 *
 * Every roll in the round is drawn from `roundSeed(seed, round, salts)`, which
 * nobody can compute until every reveal is in.
 *
 * A seat is identified by its position in `states`; the `index` field of an
 * incoming state is not trusted. A move its player may not make this round (a
 * repeated Guard or Charge, a Charge on top of a loaded one) is treated as no
 * move at all: `Match` rejects those at reveal, and the kernel must agree.
 */
export function resolveRound(
  rules: Rules,
  seed: `0x${string}`,
  round: number,
  states: readonly PlayerState[],
  moves: readonly DeclaredMove[],
  quietRounds = 0,
): RoundResolution {
  const contexts: SeatContext[] = states.map((state, seat) => ({
    seat,
    before: state,
    action: Action.None,
    target: 0,
    revealed: false,
    salt: ZERO_SALT,
    incoming: 0,
    healing: 0,
    hp: state.hp,
  }));

  // Any living player without a playable move is treated as having failed to reveal.
  for (const move of moves) {
    const context = contexts[move.index];
    if (context === undefined || !context.before.alive) continue;
    if (!move.revealed || !isLegalAction(move.action, context.before)) continue;
    context.action = move.action;
    context.target = move.action === Action.Strike ? move.target : 0;
    context.revealed = true;
    context.salt = move.salt;
  }

  const living = contexts.filter((context) => context.before.alive);
  const entropy = roundSeed(
    seed,
    round,
    saltsBySeat(
      states.length,
      living.map((context) => ({ index: context.seat, revealed: context.revealed, salt: context.salt })),
    ),
  );

  const isValidStrike = (striker: SeatContext): boolean => {
    if (striker.action !== Action.Strike) return false;
    const victim = contexts[striker.target];
    return victim !== undefined && victim.seat !== striker.seat && victim.before.alive;
  };

  // A Guard blocks exactly one of the strikers that came at it, drawn from the
  // round seed rather than by seat order: seat order is public, so "lowest
  // seat is blocked" would let the others coordinate around it.
  const blocked = new Map<number, number>();
  for (const victim of living) {
    if (victim.action !== Action.Guard) continue;
    const strikers = living.filter((striker) => isValidStrike(striker) && striker.target === victim.seat);
    if (strikers.length === 0) continue;
    const pick = Number(draw(entropy, GUARD_NONCE_BASE + victim.seat) % BigInt(strikers.length));
    blocked.set(victim.seat, (strikers[pick] as SeatContext).seat);
  }

  const strikes: StrikeRecord[] = [];
  let landed = false;

  // Strikes resolve simultaneously against the state at the start of the
  // round: damage never removes a player mid-round, so a dying player still
  // lands the strike they declared.
  for (const striker of living) {
    if (striker.action !== Action.Strike) continue;
    const charged = striker.before.charged;

    if (!isValidStrike(striker)) {
      strikes.push({ striker: striker.seat, target: striker.target, outcome: StrikeOutcome.Void, charged, damage: 0, heal: 0, reflected: 0 });
      continue;
    }
    const victim = contexts[striker.target] as SeatContext;

    if (victim.action === Action.Guard && blocked.get(victim.seat) === striker.seat) {
      striker.incoming += rules.guardReflectDamage;
      landed ||= rules.guardReflectDamage > 0;
      strikes.push({ striker: striker.seat, target: victim.seat, outcome: StrikeOutcome.Guarded, charged, damage: 0, heal: 0, reflected: rules.guardReflectDamage });
      continue;
    }

    // A guard's other strikers connect, a charging target takes extra, and a
    // player who never revealed is caught out of position and takes it all.
    const base = strikeDamageFor(rules, charged);
    const damage = victim.action === Action.Charge ? exposedDamage(rules, base) : base;
    const heal = strikeHeal(rules, damage);
    victim.incoming += damage;
    striker.healing += heal;
    landed = true;
    strikes.push({ striker: striker.seat, target: victim.seat, outcome: StrikeOutcome.Hit, charged, damage, heal, reflected: 0 });
  }

  // The stall penalty is the clock for a table that stops fighting. It only
  // fires once nobody has landed anything for `stallGraceRounds` rounds.
  const quietAfter = landed ? 0 : quietRounds + 1;
  const stall = stallDamageFor(rules, quietAfter);

  for (const context of living) {
    // Healing cannot lift a player above where they started.
    const healed = Math.min(rules.startingHp, context.before.hp - context.incoming + context.healing);
    context.hp = healed - stall;
  }

  let doomed = living.filter((context) => context.hp <= 0);
  const key = new Map(living.map((context) => [context.seat, tiebreakKey(entropy, context.seat)]));
  const byKey = (a: SeatContext, b: SeatContext): number => {
    const ka = key.get(a.seat) as bigint, kb = key.get(b.seat) as bigint;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

  // A match must always produce exactly one winner. If the round would wipe
  // every remaining player, whoever took the least overkill survives on 1 HP,
  // and an exact tie goes to the round's tiebreak draw.
  if (living.length > 0 && doomed.length === living.length) {
    const survivor = [...living].sort((a, b) => b.hp - a.hp || byKey(a, b))[0] as SeatContext;
    survivor.hp = 1;
    doomed = doomed.filter((context) => context !== survivor);
  }

  // Worst-placed first: lowest HP places lowest, then the tiebreak draw.
  const eliminated = new Set([...doomed].sort((a, b) => a.hp - b.hp || -byKey(a, b)));
  const eliminationOrder = [...eliminated].map((context) => context.seat);

  const nextStates: PlayerState[] = contexts.map((context) => {
    const isEliminated = eliminated.has(context);
    const stillAlive = context.before.alive && !isEliminated;
    const acted = context.before.alive;
    return {
      index: context.seat,
      hp: stillAlive ? Math.max(0, context.hp) : 0,
      alive: stillAlive,
      eliminatedInRound: isEliminated ? round : context.before.eliminatedInRound,
      timeouts: context.before.timeouts + (acted && !context.revealed ? 1 : 0),
      // A Strike spends a loaded Charge, hit or not; Guard and no-shows keep it.
      charged:
        stillAlive &&
        (context.action === Action.Charge || (context.before.charged && context.action !== Action.Strike)),
      lastAction: acted ? context.action : context.before.lastAction,
    };
  });

  const record: Omit<RoundRecord, 'hash'> = {
    round,
    moves: living.map((context) => ({
      index: context.seat,
      action: context.action,
      target: context.action === Action.Strike ? context.target : 0,
      revealed: context.revealed,
      salt: context.salt,
    })),
    strikes,
    stallDamage: stall,
    eliminated: eliminationOrder,
    hpAfter: nextStates.map((state) => state.hp),
  };

  return { record, states: nextStates, eliminationOrder, quietRounds: quietAfter };
}

/** Human-readable summary of a round, matching the in-game history feed. */
export function describeRound(record: Omit<RoundRecord, 'hash'>): string[] {
  const lines = record.moves.map((move) => {
    if (!move.revealed) return `#${move.index} → did not reveal`;
    if (move.action === Action.Strike) return `#${move.index} → struck #${move.target}`;
    if (move.action === Action.Guard) return `#${move.index} → guarded`;
    if (move.action === Action.Charge) return `#${move.index} → charged`;
    return `#${move.index} → ${ACTION_NAMES[move.action]}`;
  });
  if (record.stallDamage > 0) lines.push(`stall → everyone took ${record.stallDamage}`);
  for (const seat of record.eliminated) lines.push(`#${seat} → eliminated`);
  return lines;
}
