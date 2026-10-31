import { describe, expect, it } from 'vitest';
import { Action, StrikeOutcome, type RoundRecord } from '@lms/consensus';
import { type KeyMoment } from '@lms/api';
import { checkDecisiveRound, playReferenceMatch, refute, verifyMoments } from '@lms/server';

const match = playReferenceMatch({ label: 'verify', strategies: ['striker', 'guarder', 'charger', 'reader', 'random'] });
const history = match.history;

/** Every claim the history supports, derived mechanically from the records. */
function trueMoments(records: readonly RoundRecord[]): KeyMoment[] {
  const out: KeyMoment[] = [];
  const at = (round: number, seat: number, kind: KeyMoment['kind'], target: number | null = null): KeyMoment => ({
    round,
    seat,
    kind,
    target,
    claim: 'it happened',
  });
  for (const record of records) {
    for (const move of record.moves) {
      if (!move.revealed) out.push(at(record.round, move.index, 'timeout'));
      else if (move.action === Action.Strike) out.push(at(record.round, move.index, 'strike', move.target));
      else if (move.action === Action.Guard) out.push(at(record.round, move.index, 'guard'));
      else if (move.action === Action.Charge) out.push(at(record.round, move.index, 'charge'));
    }
    for (const strike of record.strikes) {
      if (strike.outcome === StrikeOutcome.Hit) out.push(at(record.round, strike.striker, 'hit', strike.target));
      if (strike.outcome === StrikeOutcome.Hit && strike.charged) {
        out.push(at(record.round, strike.striker, 'charged-hit', strike.target));
      }
      if (strike.outcome === StrikeOutcome.Guarded) out.push(at(record.round, strike.target, 'block', strike.striker));
    }
    for (const seat of record.eliminated) out.push(at(record.round, seat, 'eliminated'));
  }
  return out;
}

function moment(fields: Partial<KeyMoment>): KeyMoment {
  return { round: 1, seat: 0, kind: 'guard', target: null, claim: 'claimed', ...fields };
}

describe('claim verifier', () => {
  it('plays a reference match long enough to be interesting', () => {
    expect(history.length).toBeGreaterThan(3);
    const kinds = new Set(trueMoments(history).map((m) => m.kind));
    // The fixture exercises every kind the verifier knows except timeouts,
    // which bots never produce; those are covered separately below.
    for (const kind of ['strike', 'hit', 'charged-hit', 'block', 'guard', 'charge', 'eliminated'] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  it('keeps every claim the records support', () => {
    const moments = trueMoments(history);
    const { kept, dropped } = verifyMoments(moments, history);
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(moments.length);
  });

  it('drops a round that never happened', () => {
    expect(refute(moment({ round: history.length + 1 }), history)).toMatch(/no round/);
    expect(refute(moment({ round: 0 }), history)).toMatch(/no round/);
  });

  it('drops a claim about a seat that was already out', () => {
    const fell = history.find((record) => record.eliminated.length > 0) as RoundRecord;
    const seat = fell.eliminated[0] as number;
    const later = history.find((record) => record.round > fell.round);
    expect(later).toBeDefined();
    expect(refute(moment({ round: (later as RoundRecord).round, seat, kind: 'guard' }), history)).toMatch(
      /not alive/,
    );
  });

  it('drops the wrong action', () => {
    // Seat 1 is the guarder: it guards in round 1 and never charges.
    expect(refute(moment({ seat: 1, kind: 'guard' }), history)).toBeNull();
    expect(refute(moment({ seat: 1, kind: 'charge' }), history)).toMatch(/did not charge/);
    expect(refute(moment({ seat: 1, kind: 'strike', target: 0 }), history)).toMatch(/did not strike/);
  });

  it('drops a strike on the wrong target', () => {
    const record = history[0] as RoundRecord;
    const strike = record.moves.find((move) => move.action === Action.Strike);
    expect(strike).toBeDefined();
    const { index, target } = strike as { index: number; target: number };
    const wrong = record.moves.find((move) => move.index !== index && move.index !== target)?.index as number;
    expect(refute(moment({ seat: index, kind: 'strike', target }), history)).toBeNull();
    expect(refute(moment({ seat: index, kind: 'strike', target: wrong }), history)).toMatch(/did not strike/);
  });

  it('tells a hit from a charged hit from a block', () => {
    for (const record of history) {
      for (const strike of record.strikes) {
        const hit = moment({ round: record.round, seat: strike.striker, kind: 'hit', target: strike.target });
        const big = moment({ round: record.round, seat: strike.striker, kind: 'charged-hit', target: strike.target });
        const block = moment({ round: record.round, seat: strike.target, kind: 'block', target: strike.striker });
        expect(refute(hit, history) === null).toBe(strike.outcome === StrikeOutcome.Hit);
        expect(refute(big, history) === null).toBe(strike.outcome === StrikeOutcome.Hit && strike.charged);
        expect(refute(block, history) === null).toBe(strike.outcome === StrikeOutcome.Guarded);
      }
    }
  });

  it('drops an elimination in the wrong round', () => {
    const fell = history.find((record) => record.eliminated.length > 0) as RoundRecord;
    const seat = fell.eliminated[0] as number;
    expect(refute(moment({ round: fell.round, seat, kind: 'eliminated' }), history)).toBeNull();
    const earlier = history.find((record) => record.round < fell.round && record.moves.some((m) => m.index === seat));
    if (earlier) {
      expect(refute(moment({ round: earlier.round, seat, kind: 'eliminated' }), history)).toMatch(/not eliminated/);
    }
  });

  it('insists on a target exactly where the kind has one', () => {
    expect(refute(moment({ seat: 0, kind: 'strike', target: null }), history)).toMatch(/needs a target/);
    expect(refute(moment({ seat: 1, kind: 'guard', target: 2 }), history)).toMatch(/has no target/);
  });

  it('checks timeouts against the reveal flag', () => {
    const record: RoundRecord = {
      ...(history[0] as RoundRecord),
      moves: (history[0] as RoundRecord).moves.map((move) =>
        move.index === 2 ? { ...move, action: Action.None, revealed: false } : move,
      ),
    };
    expect(refute(moment({ seat: 2, kind: 'timeout' }), [record])).toBeNull();
    expect(refute(moment({ seat: 1, kind: 'timeout' }), [record])).toMatch(/revealed a move/);
    expect(refute(moment({ seat: 2, kind: 'charge' }), [record])).toMatch(/did not charge/);
  });

  it('keeps the decisive round only if the match had it', () => {
    expect(checkDecisiveRound(1, history)).toBe(1);
    expect(checkDecisiveRound(history.length + 5, history)).toBeNull();
    expect(checkDecisiveRound(null, history)).toBeNull();
  });
});
