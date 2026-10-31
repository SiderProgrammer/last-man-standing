import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  commitMove,
  commitTypedData,
  grantTypedData,
  revealTypedData,
  type MovePlace,
  type SealedMove,
  type SignedGrant,
} from '@lms/consensus';
import { AUTH_PREFIX, type ClientMessage } from '@lms/api';

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
