import {
  Action,
  DEFAULT_RULES,
  KEY_MOMENT_KINDS,
  addressKey,
  type RoundRecord,
  type Rules,
  type Seat,
} from '@lms/protocol';
import type { ArchivedMatch } from '../lobby/store.js';

/**
 * The analyst's standing instructions.
 *
 * Frozen: built once from constants and never interpolated with anything
 * about a particular match, player or time. It is the front of every request,
 * so one changed byte here would miss the provider's prefix cache on every
 * call behind it. Everything that varies goes in the messages.
 */
export const SYSTEM_PROMPT = `You are the post-match analyst for Last Man Standing, a hidden-information elimination game. After a match ends you explain to a player what happened and how they could play better. You write for a player who has just finished, so be concrete and brief, and refer to players by seat, like #3.

How the game works:
- 4 to 8 players start with ${DEFAULT_RULES.startingHp} HP. Every round each living player secretly commits to one action, then all actions are revealed and resolved together.
- Strike #n: deals ${DEFAULT_RULES.strikeDamage} damage to seat n unless n blocks it with a Guard. A strike that lands heals the striker ${DEFAULT_RULES.strikeHealBps / 100}% of the damage it dealt, never above ${DEFAULT_RULES.startingHp} HP.
- Guard: blocks one of the strikes that came at you (picked by the round's randomness) and reflects ${DEFAULT_RULES.guardReflectDamage} damage onto that striker. Any other strikes still connect, so focus fire beats a guard. Guard cannot be played two rounds in a row.
- Charge: loads your next Strike with ${DEFAULT_RULES.chargeBonusDamage} bonus damage. While charging you take ${DEFAULT_RULES.chargeExposureBps / 100}% more damage from strikes. Charge cannot be played two rounds in a row or while one is already loaded, and everyone can see who is charged.
- The cycle: Strike beats Charge, Guard beats Strike, Charge beats Guard. The cooldowns are public, so a seat that guarded last round is known not to be able to guard now.
- A player who does not reveal in time, or reveals a move its cooldown forbids, is recorded as a timeout: every strike on them lands.
- The stall penalty: once ${DEFAULT_RULES.stallGraceRounds} rounds in a row pass without anyone landing anything, everyone takes ${DEFAULT_RULES.stallDamage} damage, and ${DEFAULT_RULES.stallDamage} more for every further quiet round. It only exists to end a table that stops fighting.
- Players at 0 HP or below are eliminated. If a round would eliminate everyone, the one with the least overkill survives on 1 HP. The last player standing wins; the rest rank by how long they lasted.
- Every move is published after each round, so the real skill is reading the table: who always strikes, who guards whenever it can, who is charged and who it is hunting.
These are the default rules; the match data states the rules the match was actually played under, and those win if they differ.

How to work:
- The first message holds the whole match: the table, the final ranking, one line per round, then every round in full (moves, strikes and their outcomes, stall penalty, eliminations, HP), each seat's tendencies over the match, and, when the server keeps them, each seat's record in earlier matches.
- That is everything there is. Answer straight away from it. Tools, when they are offered, only repeat parts of it; do not call them unless a detail has dropped out of view.

What to write:
- summary: two or three short paragraphs telling the story of the match: how the field thinned out, who was hunted, and why the winner won.
- decisiveRound: the round that settled the outcome, or null if none did.
- keyMoments: three to six moments that shaped the match, in round order. Each names a round, a seat, a kind, and for some kinds a target seat, plus one sentence on why it mattered. The kinds are: ${KEY_MOMENT_KINDS.join(', ')}.
  strike = seat declared a strike on target; hit = seat's strike on target connected; charged-hit = seat's strike on target connected with a Charge behind it; block = seat guarded and blocked target's strike; guard = seat guarded; charge = seat charged; timeout = seat failed to reveal; eliminated = seat was knocked out. Use target only for strike, hit, charged-hit and block, and null otherwise.
- advice: two to four concrete tips for the player the analysis is written for, grounded in what the table did in this match. For a spectator, advise someone who wants to beat this table.

Every key moment is checked against the published round records before anyone sees it, and moments that do not match the records are thrown away. Only state what the records show; if you are unsure whether something happened, leave it out.`;

/**
 * The opening user message: whose perspective, the overview, then the
 * briefing — the full detail, so the model can answer without a lookup.
 */
export function renderRequest(match: ArchivedMatch, seat: number | null, briefing = ''): string {
  const perspective =
    seat === null
      ? 'Write the analysis for a spectator who did not play in this match.'
      : `Write the analysis for the player in seat #${seat}.`;
  return [perspective, renderOverview(match, seat), briefing].filter(Boolean).join('\n\n');
}

/**
 * Rules, table, ranking and one line per round: the shape of the match at a
 * glance, ahead of the full detail.
 *
 * Plain lines rather than the raw JSON records, because the records carry
 * salts and hashes the analysis has no use for and that would triple the
 * token count.
 */
export function renderOverview(match: ArchivedMatch, you: number | null): string {
  const seatOf = new Map(match.seats.map((seat) => [addressKey(seat.address), seat.index]));
  const name = (address: `0x${string}`) => {
    const seat = seatOf.get(addressKey(address));
    return seat === undefined ? short(address) : `#${seat}`;
  };

  const lines = [
    `Match ${match.result.matchId}, ${match.result.rounds} rounds.`,
    `Rules: ${renderRules(match.rules ?? DEFAULT_RULES)}`,
    `Seats: ${match.seats.map((seat) => `#${seat.index} ${short(seat.address)}${seat.index === you ? ' (you)' : ''}`).join(', ')}`,
    `Final ranking, winner first: ${match.result.ranking.map(name).join(', ')}`,
    '',
  ];
  for (const record of match.history) {
    const out = record.eliminated.length > 0 ? record.eliminated.map((seat) => `#${seat}`).join(', ') : 'nobody';
    lines.push(`Round ${record.round}: stall ${record.stallDamage}; out: ${out}; hp after: ${renderHp(record)}`);
  }
  return lines.join('\n');
}

export function renderRules(rules: Rules): string {
  return [
    `startingHp ${rules.startingHp}`,
    `strikeDamage ${rules.strikeDamage}`,
    `strikeHeal ${rules.strikeHealBps / 100}%`,
    `guardReflectDamage ${rules.guardReflectDamage}`,
    `chargeBonusDamage ${rules.chargeBonusDamage}`,
    `chargeExposure ${rules.chargeExposureBps / 100}%`,
    `stallGraceRounds ${rules.stallGraceRounds}`,
    `stallDamage ${rules.stallDamage}`,
    `maxRounds ${rules.maxRounds}`,
  ].join(', ');
}

export function renderRound(record: RoundRecord): string[] {
  const moves = record.moves.map((move) => {
    if (!move.revealed) return `#${move.index} timeout`;
    if (move.action === Action.Strike) return `#${move.index} strike #${move.target}`;
    if (move.action === Action.Guard) return `#${move.index} guard`;
    if (move.action === Action.Charge) return `#${move.index} charge`;
    return `#${move.index} none`;
  });
  const strikes = record.strikes.map((strike) => {
    const extra = [
      strike.charged ? 'charged' : '',
      strike.heal > 0 ? `heal ${strike.heal}` : '',
      strike.reflected > 0 ? `reflected ${strike.reflected}` : '',
    ].filter(Boolean);
    return `#${strike.striker}→#${strike.target} ${strike.outcome} (${[`${strike.damage} dmg`, ...extra].join(', ')})`;
  });
  return [
    `Round ${record.round}:`,
    `  moves: ${moves.join(' | ')}`,
    `  strikes: ${strikes.length > 0 ? strikes.join(' | ') : 'none'}`,
    `  stall: ${record.stallDamage}`,
    `  eliminated: ${record.eliminated.length > 0 ? record.eliminated.map((seat) => `#${seat}`).join(', ') : 'none'}`,
    `  hp after: ${renderHp(record)}`,
  ];
}

/** HP after the round of every seat that started it, floored at zero. */
function renderHp(record: RoundRecord): string {
  return record.moves.map((move) => `#${move.index} ${Math.max(0, record.hpAfter[move.index] ?? 0)}`).join(', ');
}

/** First and last four hex digits: enough to tell wallets apart, a quarter of the tokens. */
function short(address: `0x${string}`): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
