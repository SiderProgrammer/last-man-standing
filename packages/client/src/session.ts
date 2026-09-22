import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { addressKey, sameAddress, sessionCallDigest } from '@lms/protocol';

/**
 * A scoped session key, stored in the browser.
 *
 * The problem this solves: the gateway authenticates with a signed nonce, and a
 * new nonce is issued on every connection. Reconnects are ordinary — a dropped
 * socket, a refresh, a laptop waking up mid-match — so a player pays a wallet
 * prompt each time, in the middle of a round with a commit clock running.
 *
 * With EIP-7702 the player delegates their EOA once and grants a key held here.
 * That key signs the login nonce locally, and the gateway accepts it through
 * ERC-1271 because the account vouches for it. The address never changes, which
 * matters: the escrow keys seats and payouts by it.
 *
 * What is stored is a real private key, so it is scoped like one: it expires,
 * it can only call an explicit list of functions, and it can only move a capped
 * amount of value. Losing it costs at most that scope, and the player can
 * revoke it on-chain at any time.
 */
export interface StoredSession {
  privateKey: Hex;
  /** The account this key speaks for. */
  owner: Address;
  chainId: number;
  /** Unix seconds. */
  validUntil: number;
  /** Delegate the account was pointed at, so a redeploy invalidates the key. */
  delegate: Address;
}

const STORAGE_PREFIX = 'lms.session.';

/** Refuse a key this close to expiry, so one does not die mid-match. */
const EXPIRY_MARGIN_SECONDS = 120;

function storageKey(owner: Address, chainId: number): string {
  return `${STORAGE_PREFIX}${chainId}.${addressKey(owner)}`;
}

export class Session {
  private constructor(
    readonly stored: StoredSession,
    private readonly account: PrivateKeyAccount,
  ) {}

  get address(): Address {
    return this.account.address;
  }

  get expiresAt(): number {
    return this.stored.validUntil;
  }

  /** Seconds until this key stops being accepted. */
  secondsLeft(now: number = Date.now()): number {
    return Math.max(0, this.stored.validUntil - Math.floor(now / 1000));
  }

  /**
   * Loads a usable session, or null.
   *
   * Returns null rather than throwing for every reason a key might not apply —
   * expired, different account, different chain, delegate redeployed, corrupt
   * storage — because all of them mean the same thing to the caller: fall back
   * to a wallet signature.
   */
  static load(owner: Address, chainId: number, delegate: Address, now: number = Date.now()): Session | null {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey(owner, chainId));
    } catch {
      // Private browsing, or storage disabled. No session, no error.
      return null;
    }
    if (!raw) return null;

    try {
      const stored = JSON.parse(raw) as StoredSession;
      const stale =
        !sameAddress(stored.owner, owner) ||
        stored.chainId !== chainId ||
        !sameAddress(stored.delegate, delegate) ||
        stored.validUntil - EXPIRY_MARGIN_SECONDS <= Math.floor(now / 1000);
      if (stale) return null;

      return new Session(stored, privateKeyToAccount(stored.privateKey));
    } catch {
      return null;
    }
  }

  /** Mints a key locally. Nothing is authorised until the account grants it. */
  static create(owner: Address, chainId: number, delegate: Address, validUntil: number): Session {
    const privateKey = generatePrivateKey();
    return new Session(
      { privateKey, owner, chainId, delegate, validUntil },
      privateKeyToAccount(privateKey),
    );
  }

  /**
   * Persists the key.
   *
   * Called only after the granting transaction confirms: storing first would
   * leave a key the chain has never heard of, and every later login would fail
   * against it while the player watched a working wallet sit unused.
   */
  save(): void {
    try {
      localStorage.setItem(storageKey(this.stored.owner, this.stored.chainId), JSON.stringify(this.stored));
    } catch {
      // Storage refused: the session still works for this page's lifetime.
    }
  }

  static forget(owner: Address, chainId: number): void {
    try {
      localStorage.removeItem(storageKey(owner, chainId));
    } catch {
      // Nothing to do; a key that cannot be removed also cannot be read back.
    }
  }

  /** Signs the login nonce locally — the prompt this whole mechanism removes. */
  signLogin(message: string): Promise<Hex> {
    return this.account.signMessage({ message });
  }

  /**
   * Authorises one call for a relayer to submit.
   *
   * The digest itself lives in `@lms/protocol` next to the other hashes the
   * Solidity side has to agree with byte for byte.
   */
  signCall(target: Address, value: bigint, data: Hex, nonce: bigint): Promise<Hex> {
    return this.account.sign({
      hash: sessionCallDigest({
        account: this.stored.owner,
        chainId: this.stored.chainId,
        target,
        value,
        data,
        nonce,
      }),
    });
  }
}
