import { describe, expect, it } from 'vitest';
import { Action, AttackOutcome, type KeyMoment, type RoundRecord } from '@lms/protocol';
import { checkDecisiveRound, playReferenceMatch, refute, verifyMoments } from '@lms/server';

const match = playReferenceMatch({ label: 'verify', strategies: ['aggressor', 'turtle', 'hider', 'reader', 'random'] });
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
      else if (move.action === Action.Attack) out.push(at(record.round, move.index, 'attack', move.target));
      else if (move.action === Action.Defend) out.push(at(record.round, move.index, 'defend'));
      else if (move.action === Action.Hide) out.push(at(record.round, move.index, 'hide'));
    }
    for (const attack of record.attacks) {
      if (attack.outcome === AttackOutcome.Hit) out.push(at(record.round, attack.attacker, 'hit', attack.target));
      if (attack.outcome === AttackOutcome.Parried) out.push(at(record.round, attack.target, 'parry', attack.attacker));
      if (attack.outcome === AttackOutcome.Missed) out.push(at(record.round, attack.target, 'evade', attack.attacker));
    }
    for (const seat of record.eliminated) out.push(at(record.round, seat, 'eliminated'));
  }
  return out;
}

function moment(fields: Partial<KeyMoment>): KeyMoment {
  return { round: 1, seat: 0, kind: 'defend', target: null, claim: 'claimed', ...fields };
}

describe('claim verifier', () => {
  it('plays a reference match long enough to be interesting', () => {
    expect(history.length).toBeGreaterThan(3);
    const kinds = new Set(trueMoments(history).map((m) => m.kind));
    // The fixture exercises every kind the verifier knows except timeouts,
    // which bots never produce; those are covered separately below.
    for (const kind of ['attack', 'hit', 'parry', 'evade', 'defend', 'hide', 'eliminated'] as const) {
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
    expect(refute(moment({ round: (later as RoundRecord).round, seat, kind: 'defend' }), history)).toMatch(
      /not alive/,
    );
  });

  it('drops the wrong action', () => {
    // Seat 1 is the turtle: it never attacks or hides.
    expect(refute(moment({ seat: 1, kind: 'defend' }), history)).toBeNull();
    expect(refute(moment({ seat: 1, kind: 'hide' }), history)).toMatch(/did not hide/);
    expect(refute(moment({ seat: 1, kind: 'attack', target: 0 }), history)).toMatch(/did not attack/);
  });

  it('drops an attack on the wrong target', () => {
    const record = history[0] as RoundRecord;
    const attack = record.moves.find((move) => move.action === Action.Attack);
    expect(attack).toBeDefined();
    const { index, target } = attack as { index: number; target: number };
    const wrong = record.moves.find((move) => move.index !== index && move.index !== target)?.index as number;
    expect(refute(moment({ seat: index, kind: 'attack', target }), history)).toBeNull();
    expect(refute(moment({ seat: index, kind: 'attack', target: wrong }), history)).toMatch(/did not attack/);
  });

  it('tells a hit from a parry from an evade', () => {
    for (const record of history) {
      for (const attack of record.attacks) {
        const hit = moment({ round: record.round, seat: attack.attacker, kind: 'hit', target: attack.target });
        const parry = moment({ round: record.round, seat: attack.target, kind: 'parry', target: attack.attacker });
        const evade = moment({ round: record.round, seat: attack.target, kind: 'evade', target: attack.attacker });
        expect(refute(hit, history) === null).toBe(attack.outcome === AttackOutcome.Hit);
        expect(refute(parry, history) === null).toBe(attack.outcome === AttackOutcome.Parried);
        expect(refute(evade, history) === null).toBe(attack.outcome === AttackOutcome.Missed);
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
    expect(refute(moment({ seat: 0, kind: 'attack', target: null }), history)).toMatch(/needs a target/);
    expect(refute(moment({ seat: 1, kind: 'defend', target: 2 }), history)).toMatch(/has no target/);
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
    expect(refute(moment({ seat: 2, kind: 'hide' }), [record])).toMatch(/did not hide/);
  });

  it('keeps the decisive round only if the match had it', () => {
    expect(checkDecisiveRound(1, history)).toBe(1);
    expect(checkDecisiveRound(history.length + 5, history)).toBeNull();
    expect(checkDecisiveRound(null, history)).toBeNull();
  });
});
