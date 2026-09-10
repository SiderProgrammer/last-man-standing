import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';

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
  /** Hit points every player starts with. */
  startingHp: number;
  /** Damage a landed attack deals to its target. */
  attackDamage: number;
  /** Damage reflected onto an attacker whose target was defending. */
  riposteDamage: number;
  /** Probability, in basis points, that a hiding player evades an attack. */
  hideEvadeBps: number;
  /** Evade probability for a player who failed to reveal a move. */
  timeoutEvadeBps: number;
  /** Fraction of storm damage, in basis points, taken while hiding. */
  hideStormBps: number;
  /** Number of opening rounds with no storm damage. */
  stormGraceRounds: number;
  /** Storm damage added per round once the grace period is over. */
  stormBaseDamage: number;
  /** Hard cap on rounds; the match is ranked by HP if it is reached. */
  maxRounds: number;
}

/**
 * Default rule set.
 *
 * The three actions form a cycle that only closes because of the storm:
 *   - Attack beats Hide: a hider evades most attacks but takes real chip damage
 *     and can never make progress of its own.
 *   - Defend beats Attack: the attack is fully blocked and the attacker eats a
 *     riposte, so attacking into a read is a losing trade.
 *   - Hide beats Defend: both are passive, but the hider only takes half storm
 *     damage, so a turtle bleeds out faster.
 *
 * The storm is the clock. Without it, mutual defending would be a stable
 * equilibrium and no one would ever be eliminated.
 */
export const DEFAULT_RULES: Rules = {
  minPlayers: 4,
  maxPlayers: 8,
  startingHp: 100,
  attackDamage: 34,
  riposteDamage: 20,
  hideEvadeBps: 6000,
  timeoutEvadeBps: 3000,
  hideStormBps: 5000,
  stormGraceRounds: 2,
  stormBaseDamage: 6,
  maxRounds: 30,
};

export const BPS_DENOMINATOR = 10_000;

/** Storm damage inflicted at the end of the given (1-based) round. */
export function stormDamageForRound(rules: Rules, round: number): number {
  const active = round - rules.stormGraceRounds;
  return active <= 0 ? 0 : active * rules.stormBaseDamage;
}

const RULES_ABI = parseAbiParameters(
  'uint16 minPlayers, uint16 maxPlayers, uint32 startingHp, uint32 attackDamage, uint32 riposteDamage, uint16 hideEvadeBps, uint16 timeoutEvadeBps, uint16 hideStormBps, uint16 stormGraceRounds, uint32 stormBaseDamage, uint16 maxRounds',
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
      rules.attackDamage,
      rules.riposteDamage,
      rules.hideEvadeBps,
      rules.timeoutEvadeBps,
      rules.hideStormBps,
      rules.stormGraceRounds,
      rules.stormBaseDamage,
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
  if (rules.attackDamage <= 0) problems.push('attackDamage must be positive');
  if (rules.riposteDamage < 0) problems.push('riposteDamage must not be negative');
  if (rules.hideEvadeBps > BPS_DENOMINATOR) problems.push('hideEvadeBps must be <= 10000');
  if (rules.timeoutEvadeBps > BPS_DENOMINATOR) problems.push('timeoutEvadeBps must be <= 10000');
  if (rules.hideStormBps > BPS_DENOMINATOR) problems.push('hideStormBps must be <= 10000');
  if (rules.stormGraceRounds < 0) problems.push('stormGraceRounds must not be negative');
  if (rules.stormBaseDamage <= 0) problems.push('stormBaseDamage must be positive');
  if (rules.maxRounds <= 0) problems.push('maxRounds must be positive');

  // Without an escalating storm a lobby of mutual defenders never resolves.
  if (rules.stormBaseDamage * (rules.maxRounds - rules.stormGraceRounds) < rules.startingHp) {
    problems.push('storm must be able to exceed startingHp before maxRounds');
  }

  if (problems.length > 0) {
    throw new Error(`invalid rules: ${problems.join('; ')}`);
  }
}
