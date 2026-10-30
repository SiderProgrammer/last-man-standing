import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { toHex, type Address, type Hex } from 'viem';
import {
  AUTH_PREFIX,
  addressKey,
  commitTypedData,
  revealTypedData,
  sameAddress,
  sessionCallTypedData,
  type MovePlace,
  type SealedMove,
  type SessionCallParams,
  type SessionGrant,
  type SignedGrant,
} from '@lms/protocol';
import { readRaw, removeRaw, writeRaw } from '../io/storage.js';

/**
 * The key this browser plays with, and the wallet's grant to it.
 *
 * Every commit and reveal is signed, so a move in the transcript is provably
 * the player's own. Asking the wallet for each would mean two prompts a round,
 * so the wallet signs once — a grant naming a key held here — and the key signs
 * the rest. The same key signs the login nonce, so the grant also stands in
 * for a login signature: reconnecting costs no prompt until it expires.
 *
 * The key is a real private key in localStorage. It can sign logins and moves
 * for this player until the grant expires, and nothing else: no stake, no
 * transfer, no on-chain call accepts it.
 */
interface StoredGrant {
  privateKey: Hex;
  signed: SignedGrant;
}

const STORAGE_PREFIX = 'lms.grant.';

/** How long a new grant runs. A day of play, well under the server's week. */
export const GRANT_HOURS = 24;

/** Refuse a grant this close to expiry, so one does not die mid-match. */
const EXPIRY_MARGIN_SECONDS = 30 * 60;

function storageKey(wallet: Address, chainId: number): string {
  return `${STORAGE_PREFIX}${chainId}.${addressKey(wallet)}`;
}

export class GrantedKey {
  private constructor(
    readonly signed: SignedGrant,
    private readonly privateKey: Hex,
    private readonly account: PrivateKeyAccount,
  ) {}

  get grant(): SessionGrant {
    return this.signed.grant;
  }

  /** The key's own address, which the wallet grants on-chain for one-click play. */
  get address(): Address {
    return this.account.address;
  }

  /**
   * The grant this browser holds for `wallet` on `chainId`, or null when there
   * is none it should still use: expired, for another origin, or unreadable.
   */
  static load(wallet: Address, chainId: number, now: number = Date.now()): GrantedKey | null {
    const raw = readRaw(storageKey(wallet, chainId));
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as StoredGrant;
      const grant = stored.signed.grant;
      const account = privateKeyToAccount(stored.privateKey);
      const usable =
        sameAddress(grant.wallet, wallet) &&
        sameAddress(grant.sessionKey, account.address) &&
        grant.chainId === chainId &&
        grant.uri === location.origin &&
        grant.expiresAt - EXPIRY_MARGIN_SECONDS > Math.floor(now / 1000);
      return usable ? new GrantedKey(stored.signed, stored.privateKey, account) : null;
    } catch {
      return null;
    }
  }

  /**
   * Mints a key and asks the wallet to grant it: the one prompt this saves
   * every later login and move from. Stored once signed.
   */
  static async create(
    wallet: Address,
    chainId: number,
    sign: (grant: SessionGrant) => Promise<Hex>,
    now: number = Date.now(),
  ): Promise<GrantedKey> {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const issuedAt = Math.floor(now / 1000);
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const grant: SessionGrant = {
      wallet,
      sessionKey: account.address,
      domain: location.host,
      uri: location.origin,
      chainId,
      issuedAt,
      expiresAt: issuedAt + GRANT_HOURS * 3600,
      nonce: toHex(nonce),
    };
    const key = new GrantedKey({ grant, signature: await sign(grant) }, privateKey, account);
    key.save();
    return key;
  }

  static forget(wallet: Address, chainId: number): void {
    removeRaw(storageKey(wallet, chainId));
  }

  private save(): void {
    // If storage refuses, the key still works for this page's lifetime.
    const stored: StoredGrant = { privateKey: this.privateKey, signed: this.signed };
    writeRaw(storageKey(this.grant.wallet, this.grant.chainId), JSON.stringify(stored));
  }

  signLogin(nonce: string): Promise<Hex> {
    return this.account.signMessage({ message: `${AUTH_PREFIX}${nonce}` });
  }

  signCommit(place: MovePlace, commitment: Hex): Promise<Hex> {
    return this.account.signTypedData(commitTypedData(this.grant.chainId, place, commitment));
  }

  signReveal(place: MovePlace, move: SealedMove): Promise<Hex> {
    return this.account.signTypedData(revealTypedData(this.grant.chainId, place, move));
  }

  /** Signs a call for `SessionKeyDelegate.executeWithSession` on the wallet's account. */
  signSessionCall(call: SessionCallParams): Promise<Hex> {
    return this.account.signTypedData(sessionCallTypedData(call));
  }
}
