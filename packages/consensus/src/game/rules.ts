import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { Action, StrikeOutcome, type ActionValue, type RoundRecord } from './types.js';

/**
 * Tunable rules of a match.
 *
 * These are protocol parameters: on-chain governance owns the canonical copy
 * and the server mirrors them here. Every field is an integer so that engine
 * resolution stays deterministic across platforms.
 */
export interface Rules {
  /** Minimum seats that must be filled before a match can start. */
  minPlayers: number;
  /** Maximum seats in a lobby. */
  maxPlayers: number;
  /** Hit points every player starts with. The cap that healing cannot exceed. */
  startingHp: number;
  /** Damage a landed Strike deals, before any Charge bonus. */
  strikeDamage: number;
  /** Share of the damage a landed Strike deals that heals the striker, in basis points. */
  strikeHealBps: number;
  /** Damage a Guard reflects onto the one striker it blocks. */
  guardReflectDamage: number;
  /** Extra damage a Strike deals when it spends a loaded Charge. */
  chargeBonusDamage: number;
  /** Extra damage, in basis points, a player takes from strikes in the round they Charge. */
  chargeExposureBps: number;
  /** Rounds in a row without a single hit before the stall penalty starts. */
  stallGraceRounds: number;
  /** Stall penalty for the first quiet round past the grace, growing by this much each further one. */
  stallDamage: number;
  /** Hard cap on rounds; the match is ranked by HP if it is reached. */
  maxRounds: number;
}

/**
 * Default rule set.
 *
 * The three actions are a cycle, and every edge is a real exchange between
 * two players rather than a side effect:
 *   - Strike beats Charge: a charging player takes extra damage and deals none.
 *   - Guard beats Strike: the guard blocks one striker and reflects a full hit.
 *     Only one, though, so focus fire is the answer to a guard.
 *   - Charge beats Guard: the guard spent its turn while the charger loaded a
 *     hit worth more than two normal ones.
 *
 * Guard and Charge can never be played two rounds running, and Charge not
 * while one is already loaded. Those cooldowns are what stop a player from
 * turtling forever, and they are public: a seat that guarded last round
 * cannot guard now, which turns a read into a certainty.
 *
 * Landing a Strike heals the striker. Without it, damage dealt to one rival
 * helps every other rival just as much, and sitting back beats fighting.
 *
 * There is no storm. A table that stops fighting takes the stall penalty
 * instead, which only ever fires when nobody has landed a hit for
 * `stallGraceRounds` rounds.
 *
 * The numbers come from the design lab's search and validation runs, not from
 * intuition: every mindless strategy wins less than its share, each action is
 * used by good play, and an exact solve of the 1v1 duel has a fair, mixed
 * equilibrium. `npm run sim` re-checks the balance against the real engine.
 */
export const DEFAULT_RULES: Rules = {
  minPlayers: 4,
  maxPlayers: 8,
  startingHp: 100,
  strikeDamage: 25,
  strikeHealBps: 5000,
  guardReflectDamage: 34,
  chargeBonusDamage: 34,
  chargeExposureBps: 2500,
  stallGraceRounds: 2,
  stallDamage: 8,
  maxRounds: 30,
};

export const BPS_DENOMINATOR = 10_000;

/**
 * Stall penalty at the end of a round that leaves the table `quietRounds`
 * rounds in a row (this one included) without a single hit.
 */
export function stallDamageFor(rules: Rules, quietRounds: number): number {
  const over = quietRounds - rules.stallGraceRounds + 1;
  return over <= 0 ? 0 : over * rules.stallDamage;
}

/**
 * Rounds in a row, counting back from the latest, in which nobody landed
 * anything — the streak the stall penalty counts. A hit or a Guard's
 * reflection ends it.
 */
export function quietRounds(history: ReadonlyArray<Pick<RoundRecord, 'strikes'>>): number {
  let quiet = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const landed = (history[i] as Pick<RoundRecord, 'strikes'>).strikes.some(
      (strike) => strike.outcome === StrikeOutcome.Hit || strike.reflected > 0,
    );
    if (landed) break;
    quiet += 1;
  }
  return quiet;
}

/**
 * Whether `seat` carries a loaded Charge, and what it did last, after the
 * published `history`: what decides its legal moves next. Mirrors how the
 * kernel carries the two between rounds, for screens that only hold records.
 */
export function cooldownsFrom(
  history: ReadonlyArray<Pick<RoundRecord, 'moves' | 'eliminated'>>,
  seat: number,
): { charged: boolean; lastAction: ActionValue } {
  let charged = false;
  let lastAction: ActionValue = Action.None;
  for (const record of history) {
    const move = record.moves.find((entry) => entry.index === seat);
    if (!move) continue;
    lastAction = move.revealed ? move.action : Action.None;
    if (lastAction === Action.Charge) charged = true;
    else if (lastAction === Action.Strike) charged = false;
    if (record.eliminated.includes(seat)) charged = false;
  }
  return { charged, lastAction };
}

/** Damage a Strike deals before the target's response: the base, plus a spent Charge. */
export function strikeDamageFor(rules: Rules, charged: boolean): number {
  return rules.strikeDamage + (charged ? rules.chargeBonusDamage : 0);
}

/** Damage a strike lands on a target that is charging this round. */
export function exposedDamage(rules: Rules, damage: number): number {
  return Math.floor((damage * (BPS_DENOMINATOR + rules.chargeExposureBps)) / BPS_DENOMINATOR);
}

/** HP a landed hit of `damage` heals its striker. */
export function strikeHeal(rules: Rules, damage: number): number {
  return Math.floor((damage * rules.strikeHealBps) / BPS_DENOMINATOR);
}

/**
 * Whether a player may choose `action` this round. Strike is always open;
 * Guard and Charge cannot follow themselves, and Charge cannot stack.
 */
export function isLegalAction(action: ActionValue, state: { charged: boolean; lastAction: ActionValue }): boolean {
  if (action === Action.Strike) return true;
  if (action === Action.Guard) return state.lastAction !== Action.Guard;
  if (action === Action.Charge) return state.lastAction !== Action.Charge && !state.charged;
  return false;
}

/** The actions open to a player this round, in button order. */
export function legalActions(state: { charged: boolean; lastAction: ActionValue }): ActionValue[] {
  return [Action.Strike, Action.Guard, Action.Charge].filter((action) => isLegalAction(action, state));
}

const RULES_ABI = parseAbiParameters(
  'uint16 minPlayers, uint16 maxPlayers, uint32 startingHp, uint32 strikeDamage, uint16 strikeHealBps, uint32 guardReflectDamage, uint32 chargeBonusDamage, uint16 chargeExposureBps, uint16 stallGraceRounds, uint32 stallDamage, uint16 maxRounds',
);

/**
 * Digest pinning a rule set to a match. It seeds the history hash chain, so a
 * result produced under different rules cannot be replayed as if it were
 * produced under these ones.
 */
export function hashRules(rules: Rules): `0x${string}` {
  return keccak256(
    encodeAbiParameters(RULES_ABI, [
      rules.minPlayers,
      rules.maxPlayers,
      rules.startingHp,
      rules.strikeDamage,
      rules.strikeHealBps,
      rules.guardReflectDamage,
      rules.chargeBonusDamage,
      rules.chargeExposureBps,
      rules.stallGraceRounds,
      rules.stallDamage,
      rules.maxRounds,
    ]),
  );
}

/** Throws if a rule set is internally inconsistent. */
export function assertValidRules(rules: Rules): void {
  const problems: string[] = [];
  if (rules.minPlayers < 2) problems.push('minPlayers must be at least 2');
  if (rules.maxPlayers < rules.minPlayers) problems.push('maxPlayers must be >= minPlayers');
  if (rules.maxPlayers > 256) problems.push('maxPlayers must be <= 256 (seat index is uint8)');
  if (rules.startingHp <= 0) problems.push('startingHp must be positive');
  if (rules.strikeDamage <= 0) problems.push('strikeDamage must be positive');
  if (rules.strikeHealBps < 0 || rules.strikeHealBps > BPS_DENOMINATOR) problems.push('strikeHealBps must be within [0, 10000]');
  if (rules.guardReflectDamage < 0) problems.push('guardReflectDamage must not be negative');
  if (rules.chargeBonusDamage <= 0) problems.push('chargeBonusDamage must be positive');
  if (rules.chargeExposureBps < 0 || rules.chargeExposureBps > BPS_DENOMINATOR) problems.push('chargeExposureBps must be within [0, 10000]');
  if (rules.maxRounds <= 0) problems.push('maxRounds must be positive');

  // Without it, a table where nobody strikes never takes damage and every
  // match it reaches runs to the round cap.
  if (rules.stallGraceRounds < 1) problems.push('stallGraceRounds must be at least 1');
  if (rules.stallDamage <= 0) problems.push('stallDamage must be positive');

  if (problems.length > 0) {
    throw new Error(`invalid rules: ${problems.join('; ')}`);
  }
}
