import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  Action,
  DEFAULT_RULES,
  commitMove,
  commitTypedData,
  grantTypedData,
  revealTypedData,
  type MovePlace,
  type SealedMove,
  type SignedGrant,
  type Transcript,
} from '@lms/consensus';
import { AUTH_PREFIX, type ClientMessage } from '@lms/api';
import type { OwnMove } from '@lms/engine';
import { Room } from '@lms/server';
import { bytes32 } from './helpers.js';

/**
 * A player as the browser is one: a wallet, and a session key the wallet
 * grants, which signs the login and every move.
 */
export class TestPlayer {
  readonly wallet: PrivateKeyAccount;
  readonly key: PrivateKeyAccount;

  constructor(
    seed: string,
    readonly chainId: number,
  ) {
    this.wallet = privateKeyToAccount(keccak256(toHex(`wallet:${seed}`)));
    this.key = privateKeyToAccount(keccak256(toHex(`key:${seed}`)));
  }

  get address(): `0x${string}` {
    return this.wallet.address;
  }

  /** A grant from `issuedAt` (unix seconds) for `seconds`. */
  async grant(issuedAt = 0, seconds = 3_600, overrides: Partial<SignedGrant['grant']> = {}): Promise<SignedGrant> {
    const grant = {
      wallet: this.address,
      sessionKey: this.key.address,
      domain: 'play.test',
      uri: 'https://play.test',
      chainId: this.chainId,
      issuedAt,
      expiresAt: issuedAt + seconds,
      nonce: keccak256(toHex(`nonce:${issuedAt}`)),
      ...overrides,
    };
    return { grant, signature: await this.wallet.signTypedData(grantTypedData(grant)) };
  }

  async auth(nonce: string, grant?: SignedGrant): Promise<ClientMessage> {
    const signed = grant ?? (await this.grant());
    const signature = await this.key.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
    return { type: 'auth', address: this.address, signature, grant: signed };
  }

  async commit(place: MovePlace, move: SealedMove, hold = false): Promise<ClientMessage> {
    const commitment = commitMove(place.matchId, place.round, place.seat, move);
    const signature = await this.key.signTypedData(commitTypedData(this.chainId, place, commitment));
    const aim = { matchId: place.matchId, round: place.round };
    if (!hold) return { type: 'commit', commitment, signature, ...aim };
    const held = await this.key.signTypedData(revealTypedData(this.chainId, place, move));
    return { type: 'commit', commitment, signature, hold: { ...move, signature: held }, ...aim };
  }

  async reveal(place: MovePlace, move: SealedMove): Promise<ClientMessage> {
    const signature = await this.key.signTypedData(revealTypedData(this.chainId, place, move));
    return { type: 'reveal', ...move, signature, matchId: place.matchId, round: place.round };
  }
}

/**
 * Plays a whole match through a real room with every seat a signed player,
 * the way the gateway feeds it, and returns the transcript the room hands
 * the lobby, plus what seat 0's browser remembers.
 */
export async function playSigned(
  label: string,
  chainId: number,
  players = Array.from({ length: 4 }, (_, i) => new TestPlayer(`${label}:${i}`, chainId)),
) {
  const grants = await Promise.all(players.map((player) => player.grant()));
  const seats = players.map((player, index) => ({ index, address: player.address, chainId: chainId }));
  let transcript: Transcript | null = null;
  const room = new Room(
    { matchId: bytes32(`match:${label}`), seats, seed: bytes32(`seed:${label}`), rules: DEFAULT_RULES },
    { commitMs: 10_000, revealMs: 5_000, botSeats: [], chainId: chainId, onFinished: (t) => (transcript = t) },
    0,
  );
  const own = new Map<number, OwnMove>();
  let now = 1;
  while (!room.finished) {
    const round = room.match.round;
    const alive = room.match.alive;
    const moves = new Map<number, SealedMove>();
    for (const seat of alive) {
      const target = alive.find((other) => other !== seat) ?? 0;
      const move = { action: round % 3 === 0 ? Action.Guard : Action.Strike, target, salt: bytes32(`${label}:${round}:${seat}`) };
      moves.set(seat, move);
      const place = { matchId: room.matchId, round, seat };
      const commitment = commitMove(room.matchId, round, seat, move);
      const signature = await players[seat]!.key.signTypedData(commitTypedData(chainId, place, commitment));
      room.submitCommit(seats[seat]!.address, commitment, now, undefined, undefined, { grant: grants[seat]!, signature });
      if (seat === 0) own.set(round, { ...move, receipt: { receivedAt: now, signature: '0x' }, revealed: true });
    }
    for (const seat of alive) {
      const place = { matchId: room.matchId, round, seat };
      const move = moves.get(seat)!;
      const signature = await players[seat]!.key.signTypedData(revealTypedData(chainId, place, move));
      room.submitReveal(seats[seat]!.address, move, now, undefined, { grant: grants[seat]!, signature });
    }
    now += 1_000;
  }
  if (!transcript) throw new Error('the match never finished');
  return { transcript: transcript as Transcript, own: { seat: 0, moves: own } };
}
