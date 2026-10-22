import {
  Action,
  StrikeOutcome,
  TARGETED_MOMENT_KINDS,
  type KeyMoment,
  type RoundRecord,
} from '@lms/protocol';

/** A moment the history does not support, and why. */
export interface DroppedMoment {
  moment: KeyMoment;
  reason: string;
}

export interface Verification {
  kept: KeyMoment[];
  dropped: DroppedMoment[];
}

/**
 * Checks every key moment against the published round records and keeps only
 * the ones the history bears out.
 *
 * Deterministic and model-free on purpose: a language model asked to judge
 * another language model's claims can be wrong in the same way twice, while
 * the history is the ground truth the whole game already rests on. It checks
 * the structured part of a claim — round, seat, kind, target — and not the
 * sentence attached to it, which is the one part left to the reader's trust.
 */
export function verifyMoments(moments: readonly KeyMoment[], history: readonly RoundRecord[]): Verification {
  const kept: KeyMoment[] = [];
  const dropped: DroppedMoment[] = [];
  for (const moment of moments) {
    const reason = refute(moment, history);
    if (reason === null) kept.push(moment);
    else dropped.push({ moment, reason });
  }
  return { kept, dropped };
}

/** Why the history contradicts a moment, or null if it supports it. */
export function refute(moment: KeyMoment, history: readonly RoundRecord[]): string | null {
  const record = history.find((round) => round.round === moment.round);
  if (!record) return `there is no round ${moment.round}`;

  // `moves` lists exactly the seats alive at the start of the round.
  const move = record.moves.find((entry) => entry.index === moment.seat);
  if (!move) return `seat ${moment.seat} was not alive in round ${moment.round}`;

  const targeted = TARGETED_MOMENT_KINDS.includes(moment.kind);
  if (targeted && moment.target === null) return `a ${moment.kind} needs a target`;
  if (!targeted && moment.target !== null) return `a ${moment.kind} has no target`;
  const target = moment.target;

  const strike = (striker: number, victim: number) =>
    record.strikes.find((entry) => entry.striker === striker && entry.target === victim);

  switch (moment.kind) {
    case 'strike':
      return move.revealed && move.action === Action.Strike && move.target === target
        ? null
        : `seat ${moment.seat} did not strike seat ${target} in round ${moment.round}`;
    case 'hit':
      return strike(moment.seat, target as number)?.outcome === StrikeOutcome.Hit
        ? null
        : `seat ${moment.seat} did not land a hit on seat ${target} in round ${moment.round}`;
    case 'charged-hit': {
      const landed = strike(moment.seat, target as number);
      return landed?.outcome === StrikeOutcome.Hit && landed.charged
        ? null
        : `seat ${moment.seat} did not land a charged hit on seat ${target} in round ${moment.round}`;
    }
    case 'block':
      return strike(target as number, moment.seat)?.outcome === StrikeOutcome.Guarded
        ? null
        : `seat ${moment.seat} did not block seat ${target} in round ${moment.round}`;
    case 'guard':
      return move.revealed && move.action === Action.Guard
        ? null
        : `seat ${moment.seat} did not guard in round ${moment.round}`;
    case 'charge':
      return move.revealed && move.action === Action.Charge
        ? null
        : `seat ${moment.seat} did not charge in round ${moment.round}`;
    case 'timeout':
      return !move.revealed ? null : `seat ${moment.seat} revealed a move in round ${moment.round}`;
    case 'eliminated':
      return record.eliminated.includes(moment.seat)
        ? null
        : `seat ${moment.seat} was not eliminated in round ${moment.round}`;
  }
}

/** The decisive round if it is one the match actually had, else null. */
export function checkDecisiveRound(round: number | null, history: readonly RoundRecord[]): number | null {
  if (round === null) return null;
  return history.some((record) => record.round === round) ? round : null;
}
