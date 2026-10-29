import { describe, expect, it } from 'vitest';
import {
  Action,
  MatchPhase,
  commitMove,
  type MatchPhaseValue,
  type SealedMove,
} from '@lms/protocol';
import { Room, type RoomOptions } from '@lms/server';
import { FakeClient, HUMAN, botSeats, bytes32, setupWithBots } from './helpers.js';

const OPTIONS: RoomOptions = {
  commitMs: 10_000,
  revealMs: 5_000,
  botSeats: [],
};

function room(seatCount = 4, label = 'room', extra: Partial<RoomOptions> = {}) {
  const setup = setupWithBots(seatCount, label);
  return new Room(setup, { ...OPTIONS, botSeats: botSeats(seatCount), ...extra }, 0);
}

function humanMove(instance: Room, action: SealedMove['action'], target = 0): SealedMove {
  return { action, target, salt: bytes32(`salt:${instance.match.round}`) };
}

/** Plays the human seat until the match ends, so bots drive the rest. */
function playOut(instance: Room, now = 0): number {
  let clock = now;
  let guard = 0;
  while (!instance.finished && guard++ < 200) {
    clock += 1_000;
    // Read the phase into a local so the check below narrows the local rather
    // than `instance.match.phase` itself: the commit can open the reveal window
    // mid-iteration, which control-flow analysis of a getter cannot see.
    const phase: MatchPhaseValue = instance.match.phase;
    // Under a replay hold a commit is kept without opening the reveal, so the
    // human may already be committed while the phase is still Commit.
    const pending = instance.match.publicState().committed.includes(0);
    if (phase === MatchPhase.Commit && instance.match.playerState(0).alive && !pending) {
      const target = instance.match.alive.find((seat) => seat !== 0) ?? 0;
      const move = humanMove(instance, Action.Strike, target);
      instance.submitCommit(HUMAN, commitMove(instance.matchId, instance.match.round, 0, move), clock);
      if (instance.match.phase === MatchPhase.Reveal) instance.submitReveal(HUMAN, move, clock);
    } else {
      instance.tick(clock + 60_000);
    }
  }
  return clock;
}

describe('room lifecycle', () => {
  it('opens in the commit phase with the bots already committed', () => {
    const instance = room();
    const state = instance.match.publicState();

    expect(state.phase).toBe(MatchPhase.Commit);
    expect(state.committed).toEqual([1, 2, 3]);
    expect(state.revealed).toEqual([]);
    expect(instance.deadline).toBe(OPTIONS.commitMs);
  });

  it('closes the round as soon as the human completes the commit/reveal pair', () => {
    const instance = room();
    const client = new FakeClient(HUMAN);
    instance.attach(client);

    const move = humanMove(instance, Action.Guard);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 1, 0, move), 1_000);
    // Every seat has committed, so the reveal window opened immediately.
    expect(instance.match.phase).toBe(MatchPhase.Reveal);

    instance.submitReveal(HUMAN, move, 1_500);
    expect(instance.match.round).toBe(2);
    expect(client.all('round')).toHaveLength(1);
    expect(client.last('round')?.lines.some((line) => line.includes('#0'))).toBe(true);
  });

  it('resolves a round on the clock when the human never acts', () => {
    const instance = room();
    instance.tick(OPTIONS.commitMs + 1);
    // Bots revealed on the spot, so the round resolved without a reveal window.
    expect(instance.match.round).toBe(2);
    expect(instance.match.playerState(0).timeouts).toBe(1);
  });

  it('never leaks a pending move to spectators', () => {
    const instance = room();
    const spectator = new FakeClient('0x00000000000000000000000000000000000000ff');
    instance.attach(spectator);

    const move = humanMove(instance, Action.Strike, 2);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 1, 0, move), 100);

    const snapshot = JSON.stringify(spectator.last('state'));
    expect(snapshot).not.toContain('"action"');
    expect(spectator.last('state')?.you).toBeNull();
  });

  it('rejects a reveal that does not match the commitment', () => {
    const instance = room();
    const honest = humanMove(instance, Action.Guard);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 1, 0, honest), 100);

    expect(() => instance.submitReveal(HUMAN, humanMove(instance, Action.Strike, 1), 200)).toThrow(
      /commitment/,
    );
  });

  it('refuses moves from a wallet without a seat', () => {
    const instance = room();
    const stranger = '0x00000000000000000000000000000000000000ee' as const;
    expect(() => instance.submitCommit(stranger, bytes32('x'), 100)).toThrow(expect.objectContaining({ code: 'NOT_SEATED' }));
  });

  it('refuses to let a client play a bot seat', () => {
    const setup = setupWithBots(4, 'bot-seat');
    const instance = new Room(setup, { ...OPTIONS, botSeats: [1, 2, 3] }, 0);
    const botAddress = setup.seats[1]?.address as `0x${string}`;
    expect(() => instance.submitCommit(botAddress, bytes32('x'), 100)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('runs to a single winner and reports a signable result', () => {
    let finished: { rounds: number; ranking: readonly string[] } | null = null;
    const instance = room(4, 'complete', {
      onFinished: (result) => {
        finished = { rounds: result.rounds, ranking: result.ranking };
      },
    });
    const client = new FakeClient(HUMAN);
    instance.attach(client);

    playOut(instance);

    expect(instance.finished).toBe(true);
    expect(instance.match.alive).toHaveLength(1);
    expect(finished).not.toBeNull();
    expect(client.last('finished')?.result.historyRoot).toBe(instance.match.historyRoot);
    expect(new Set(client.last('finished')?.ranking).size).toBe(4);
  });
});

describe('replay hold', () => {
  const REPLAY = 2_500;

  /** Resolves round 1 at t=1000 by committing and revealing the human's move. */
  function resolveFirstRound(instance: Room): void {
    const move = humanMove(instance, Action.Guard);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 1, 0, move), 1_000);
    instance.submitReveal(HUMAN, move, 1_000);
  }

  it('starts the next commit clock only after the replay', () => {
    const instance = room(4, 'hold-deadline', { replayMs: REPLAY });
    resolveFirstRound(instance);

    expect(instance.match.round).toBe(2);
    expect(instance.deadline).toBe(1_000 + REPLAY + OPTIONS.commitMs);
  });

  it('tells clients how long the replay lasts', () => {
    const instance = room(4, 'hold-message', { replayMs: REPLAY });
    const client = new FakeClient(HUMAN);
    instance.attach(client);
    resolveFirstRound(instance);

    expect(client.last('round')?.replayMs).toBe(REPLAY);
  });

  /**
   * The trap this guards: bots commit the instant a round resolves, so a
   * human locking in during the replay would complete the table and skip the
   * pause entirely.
   */
  it('keeps a commit made during the replay but does not open the reveal early', () => {
    const instance = room(4, 'hold-early', { replayMs: REPLAY });
    resolveFirstRound(instance);

    const move = humanMove(instance, Action.Charge);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 2, 0, move), 1_500);

    expect(instance.match.phase).toBe(MatchPhase.Commit);
    expect(instance.match.publicState().committed).toContain(0);
  });

  it('opens the reveal as soon as the replay ends for a table that is already committed', () => {
    const instance = room(4, 'hold-release', { replayMs: REPLAY });
    resolveFirstRound(instance);
    const move = humanMove(instance, Action.Charge);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 2, 0, move), 1_500);

    instance.tick(1_000 + REPLAY - 1);
    expect(instance.match.phase).toBe(MatchPhase.Commit);

    instance.tick(1_000 + REPLAY);
    expect(instance.match.phase).toBe(MatchPhase.Reveal);
  });

  it('does not wait on the replay for a table that has not committed', () => {
    const instance = room(4, 'hold-waiting', { replayMs: REPLAY });
    resolveFirstRound(instance);

    // The hold ends with the human still thinking: the clock runs as normal.
    instance.tick(1_000 + REPLAY + 1);
    expect(instance.match.phase).toBe(MatchPhase.Commit);
  });

  it('never holds back the result of the final round', () => {
    let finishedAt: number | null = null;
    const instance = room(4, 'hold-final', {
      replayMs: REPLAY,
      onFinished: () => {
        finishedAt = instance.match.round;
      },
    });
    const client = new FakeClient(HUMAN);
    instance.attach(client);

    playOut(instance);

    // Settlement fires the moment the last round resolves; only the client
    // waits to *show* it.
    expect(finishedAt).not.toBeNull();
    expect(client.last('finished')).toBeDefined();
  });

  it('opens the next window immediately with no replay configured', () => {
    const instance = room(4, 'hold-none');
    resolveFirstRound(instance);

    expect(instance.deadline).toBe(1_000 + OPTIONS.commitMs);
    const move = humanMove(instance, Action.Charge);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 2, 0, move), 1_001);
    expect(instance.match.phase).toBe(MatchPhase.Reveal);
  });
});

describe('spectators', () => {
  it('attaches a spectator without seating them', () => {
    const instance = room(4, 'spectator');
    const spectator = new FakeClient('0x00000000000000000000000000000000000000cc');
    instance.attach(spectator);

    expect(instance.seatOf(spectator.address as `0x${string}`)).toBeNull();
    expect(spectator.last('state')?.you).toBeNull();
  });
});

describe('move aim', () => {
  it('refuses a commit made for another round instead of taking it for this one', () => {
    const instance = room();
    const move = humanMove(instance, Action.Guard);
    const stale = commitMove(instance.matchId, 0, 0, move);
    expect(() => instance.submitCommit(HUMAN, stale, 0, undefined, { matchId: instance.matchId, round: 0 })).toThrow(
      expect.objectContaining({ code: 'STALE_MOVE', message: expect.stringMatching(/for round 0; the match is on round 1/) }),
    );
    expect(instance.match.publicState().committed).not.toContain(0);
  });

  it('refuses a move made for another match', () => {
    const instance = room();
    const move = humanMove(instance, Action.Guard);
    const commitment = commitMove(instance.matchId, 1, 0, move);
    expect(() => instance.submitCommit(HUMAN, commitment, 0, undefined, { matchId: bytes32('elsewhere'), round: 1 })).toThrow(
      expect.objectContaining({ code: 'STALE_MOVE', message: expect.stringMatching(/another match/) }),
    );
  });

  it('accepts a move that names the match and round in progress', () => {
    const instance = room();
    const move = humanMove(instance, Action.Guard);
    const commitment = commitMove(instance.matchId, instance.match.round, 0, move);
    instance.submitCommit(HUMAN, commitment, 0, undefined, { matchId: instance.matchId, round: instance.match.round });
    expect(instance.match.publicState().committed).toContain(0);
  });
});
