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
  startingChips: 1_000,
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
    if (phase === MatchPhase.Commit && instance.match.playerState(0).alive) {
      const target = instance.match.alive.find((seat) => seat !== 0) ?? 0;
      const move = humanMove(instance, Action.Attack, target);
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

    const move = humanMove(instance, Action.Defend);
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

    const move = humanMove(instance, Action.Attack, 2);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 1, 0, move), 100);

    const snapshot = JSON.stringify(spectator.last('state'));
    expect(snapshot).not.toContain('"action"');
    expect(spectator.last('state')?.you).toBeNull();
  });

  it('rejects a reveal that does not match the commitment', () => {
    const instance = room();
    const honest = humanMove(instance, Action.Defend);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 1, 0, honest), 100);

    expect(() => instance.submitReveal(HUMAN, humanMove(instance, Action.Attack, 1), 200)).toThrow(
      /commitment/,
    );
  });

  it('refuses moves from a wallet without a seat', () => {
    const instance = room();
    const stranger = '0x00000000000000000000000000000000000000ee' as const;
    expect(() => instance.submitCommit(stranger, bytes32('x'), 100)).toThrow(/not seated/);
  });

  it('refuses to let a client play a bot seat', () => {
    const setup = setupWithBots(4, 'bot-seat');
    const instance = new Room(setup, { ...OPTIONS, botSeats: [1, 2, 3] }, 0);
    const botAddress = setup.seats[1]?.address as `0x${string}`;
    expect(() => instance.submitCommit(botAddress, bytes32('x'), 100)).toThrow(/house bot/);
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

describe('spectator book', () => {
  it('escrows chips when a bet is placed and pays the winners', () => {
    const instance = room(4, 'book');
    const client = new FakeClient(HUMAN);
    instance.attach(client);

    // Seat 1 is on the brink, so back it to fall this round.
    instance.placeBet(HUMAN, 1, 200);
    expect(instance.chipsOf(HUMAN)).toBe(800);
    expect(instance.bookSnapshot(HUMAN).yours[1]).toBe(200);

    const move = humanMove(instance, Action.Attack, 1);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, 1, 0, move), 100);
    instance.submitReveal(HUMAN, move, 200);

    const record = client.last('round')?.record;
    const hit = record?.eliminated.includes(1) ?? false;
    // The only ticket in the book: a hit returns the whole pot, a miss refunds.
    expect(instance.chipsOf(HUMAN)).toBe(1_000);
    expect(hit || instance.chipsOf(HUMAN) === 1_000).toBe(true);
  });

  it('closes the book once the commit window has closed', () => {
    const instance = room(4, 'closed');
    instance.tick(OPTIONS.commitMs + 1);
    instance.tick(OPTIONS.commitMs + 2);

    const move = humanMove(instance, Action.Hide);
    instance.submitCommit(HUMAN, commitMove(instance.matchId, instance.match.round, 0, move), 1);
    expect(instance.match.phase).toBe(MatchPhase.Reveal);
    expect(() => instance.placeBet(HUMAN, 2, 10)).toThrow(/book is closed/);
  });

  it('rejects a bet larger than the stack or on a dead seat', () => {
    const instance = room(4, 'limits');
    expect(() => instance.placeBet(HUMAN, 1, 5_000)).toThrow(/not enough chips/);
    expect(() => instance.placeBet(HUMAN, 1, 0)).toThrow(/positive integer/);
  });

  it('gives a spectator a stack without seating them', () => {
    const instance = room(4, 'spectator');
    const spectator = new FakeClient('0x00000000000000000000000000000000000000cc');
    instance.attach(spectator);

    expect(instance.chipsOf(spectator.address)).toBe(1_000);
    expect(instance.seatOf(spectator.address as `0x${string}`)).toBeNull();
    instance.placeBet(spectator.address as `0x${string}`, 2, 100);
    expect(instance.chipsOf(spectator.address)).toBe(900);
  });
});
