import {
  Action,
  ACTION_NAMES,
  AttackOutcome,
  BPS_DENOMINATOR,
  draw,
  drawBps,
  roundSeed,
  saltsBySeat,
  stormDamageForRound,
  ZERO_SALT,
  type ActionValue,
  type AttackRecord,
  type PlayerState,
  type RoundRecord,
  type Rules,
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
}

/**
 * Nonce space for the defender's parry pick. Evade rolls use the attacker's
 * seat (below 256, since seats are `uint8`), so offsetting by 256 keeps the two
 * kinds of draw independent.
 */
export const PARRY_NONCE_BASE = 256;

/** Scratch state for one seat while a round is being resolved. */
interface SeatContext {
  readonly seat: number;
  readonly before: PlayerState;
  action: ActionValue;
  target: number;
  revealed: boolean;
  salt: `0x${string}`;
  /** Damage accumulated from attacks and ripostes this round. */
  incoming: number;
  /** Hit points after damage. Allowed to go negative to rank overkill. */
  hp: number;
}

/**
 * Resolves a single round.
 *
 * Pure and total: given the same rules, seed, round number, states, and moves
 * it always produces the same output, with no reliance on the iteration order
 * of the input moves, wall-clock time, or floating point. This is what makes a
 * match independently replayable from its seed and move log.
 *
 * Every roll in the round is drawn from `roundSeed(seed, round, salts)`, which
 * nobody can compute until every reveal is in.
 *
 * A seat is identified by its position in `states`; the `index` field of an
 * incoming state is not trusted.
 */
export function resolveRound(
  rules: Rules,
  seed: `0x${string}`,
  round: number,
  states: readonly PlayerState[],
  moves: readonly DeclaredMove[],
): RoundResolution {
  const contexts: SeatContext[] = states.map((state, seat) => ({
    seat,
    before: state,
    action: Action.None,
    target: 0,
    revealed: false,
    salt: ZERO_SALT,
    incoming: 0,
    hp: state.hp,
  }));

  // Any living player without a move is treated as having failed to reveal.
  for (const move of moves) {
    const context = contexts[move.index];
    if (context === undefined || !context.before.alive) continue;
    context.action = move.action;
    context.target = move.target;
    context.revealed = move.revealed;
    context.salt = move.revealed ? move.salt : ZERO_SALT;
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

  const isValidAttack = (attacker: SeatContext): boolean => {
    if (attacker.action !== Action.Attack) return false;
    const victim = contexts[attacker.target];
    return victim !== undefined && victim.seat !== attacker.seat && victim.before.alive;
  };

  // A defender parries exactly one of the attackers that came at it, drawn
  // from the round seed rather than by seat order: seat order is public, so
  // "lowest seat is parried" would let the others coordinate around it.
  const parried = new Map<number, number>();
  for (const victim of living) {
    if (victim.action !== Action.Defend) continue;
    const attackers = living.filter(
      (attacker) => isValidAttack(attacker) && attacker.target === victim.seat,
    );
    if (attackers.length === 0) continue;
    const pick = Number(draw(entropy, PARRY_NONCE_BASE + victim.seat) % BigInt(attackers.length));
    parried.set(victim.seat, (attackers[pick] as SeatContext).seat);
  }

  const attacks: AttackRecord[] = [];

  // Attacks resolve simultaneously against the state at the start of the
  // round: damage never removes a player mid-round, so a dying player still
  // lands the attack they declared.
  for (const attacker of living) {
    if (attacker.action !== Action.Attack) continue;

    if (!isValidAttack(attacker)) {
      attacks.push({
        attacker: attacker.seat,
        target: attacker.target,
        outcome: AttackOutcome.Void,
        damage: 0,
        riposte: 0,
      });
      continue;
    }
    const victim = contexts[attacker.target] as SeatContext;

    if (victim.action === Action.Defend && parried.get(victim.seat) === attacker.seat) {
      attacker.incoming += rules.riposteDamage;
      attacks.push({
        attacker: attacker.seat,
        target: victim.seat,
        outcome: AttackOutcome.Parried,
        damage: 0,
        riposte: rules.riposteDamage,
      });
      continue;
    }

    // Only a hider evades. A defender's other attackers connect, and a player
    // who never revealed is caught out of position and takes every hit.
    // The nonce is the attacker's seat, so each roll is independent of how
    // many attacks were resolved before it.
    if (victim.action === Action.Hide && drawBps(entropy, attacker.seat) < rules.hideEvadeBps) {
      attacks.push({
        attacker: attacker.seat,
        target: victim.seat,
        outcome: AttackOutcome.Missed,
        damage: 0,
        riposte: 0,
      });
      continue;
    }

    victim.incoming += rules.attackDamage;
    attacks.push({
      attacker: attacker.seat,
      target: victim.seat,
      outcome: AttackOutcome.Hit,
      damage: rules.attackDamage,
      riposte: 0,
    });
  }

  // The storm is the clock that stops mutual defending from being stable.
  // Hiders take a reduced share; everyone else takes it in full.
  const storm = stormDamageForRound(rules, round);
  const hiddenStorm = Math.floor((storm * rules.hideStormBps) / BPS_DENOMINATOR);

  for (const context of living) {
    const stormTaken = context.action === Action.Hide ? hiddenStorm : storm;
    context.hp = context.before.hp - context.incoming - stormTaken;
  }

  let doomed = living.filter((context) => context.hp <= 0);

  // A match must always produce exactly one winner. If the round would wipe
  // every remaining player, whoever took the least overkill survives on 1 HP;
  // `reduce` keeps the earlier seat on a perfect tie.
  if (living.length > 0 && doomed.length === living.length) {
    const survivor = living.reduce((best, context) => (context.hp > best.hp ? context : best));
    survivor.hp = 1;
    doomed = doomed.filter((context) => context !== survivor);
  }

  // Worst-placed first: lowest HP loses the tiebreak, then lowest seat index.
  const eliminated = new Set(
    [...doomed].sort((a, b) => (a.hp !== b.hp ? a.hp - b.hp : a.seat - b.seat)),
  );
  const eliminationOrder = [...eliminated].map((context) => context.seat);

  const nextStates: PlayerState[] = contexts.map((context) => {
    const isEliminated = eliminated.has(context);
    const stillAlive = context.before.alive && !isEliminated;
    return {
      index: context.seat,
      hp: stillAlive ? Math.max(0, context.hp) : 0,
      alive: stillAlive,
      eliminatedInRound: isEliminated ? round : context.before.eliminatedInRound,
      timeouts: context.before.timeouts + (context.before.alive && !context.revealed ? 1 : 0),
    };
  });

  const record: Omit<RoundRecord, 'hash'> = {
    round,
    moves: living.map((context) => ({
      index: context.seat,
      action: context.action,
      target: context.action === Action.Attack ? context.target : 0,
      revealed: context.revealed,
      salt: context.salt,
    })),
    attacks,
    stormDamage: storm,
    eliminated: eliminationOrder,
    hpAfter: nextStates.map((state) => state.hp),
  };

  return { record, states: nextStates, eliminationOrder };
}

/** Human-readable summary of a round, matching the in-game history feed. */
export function describeRound(record: Omit<RoundRecord, 'hash'>): string[] {
  const lines = record.moves.map((move) => {
    if (!move.revealed) return `#${move.index} → did not reveal`;
    if (move.action === Action.Attack) return `#${move.index} → attacked #${move.target}`;
    if (move.action === Action.Defend) return `#${move.index} → defended`;
    if (move.action === Action.Hide) return `#${move.index} → hid`;
    return `#${move.index} → ${ACTION_NAMES[move.action]}`;
  });
  for (const seat of record.eliminated) lines.push(`#${seat} → eliminated`);
  return lines;
}
