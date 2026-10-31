import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Address, type Hex } from 'viem';
import {
  gameEscrowAbi,
  isDelegatedTo,
  sessionCallKind,
  sessionKeyDelegateAbi,
  type RelayedCall,
  type SessionCallKind,
} from '@lms/protocol';
import { RequestError } from '../errors.js';
import { RevertedError, type TxSender } from './txSender.js';
import { readClient } from './viem.js';

/**
 * Submits calls a player's session key signed, and pays their gas.
 *
 * This is what one-click play is: the player's browser signs a `join` with a
 * key the wallet granted on-chain, and the server sends it. The stake comes
 * from the player's own account; only the gas is the server's. The delegate
 * enforces the key's scope and caps on-chain, so nothing here can make a key
 * do more than it was granted. What the server does guard is its own gas:
 *
 *   * the call must be one the delegate would accept, checked before anything
 *     costs an RPC call;
 *   * the account must be delegated to *our* delegate, because the call is
 *     sent to the account's address, and code of any other origin would run
 *     on the server's gas;
 *   * it must simulate cleanly, so a revert costs a read, not a transaction;
 *   * each wallet gets `quotaPerDay` relayed calls per UTC day.
 */
export interface RelayPort {
  /** The code at `account`: a 7702 delegation designator, or empty. */
  codeOf(account: Address): Promise<Hex | undefined>;
  /**
   * Simulates `executeWithSession` on `account` from the relayer, then sends
   * it and waits for it to be mined. Throws on a revert at either stage, or
   * if the same call is already being relayed.
   */
  submit(account: Address, call: RelayedCall): Promise<Hex>;
}

export interface SessionRelayOptions {
  port: RelayPort;
  escrow: Address;
  delegate: Address;
  /** Relayed calls per wallet per UTC day. Ignored when `quota` is given. */
  quotaPerDay: number;
  /** A quota shared with the relayer's other work, withdrawals to a spoke. */
  quota?: DailyQuota;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Calls the relayer pays for, per wallet per UTC day: one count for every
 * kind, since they all spend the same key's gas.
 */
export class DailyQuota {
  /** Calls relayed today, by lowercased wallet. Cleared when the day turns. */
  private used = new Map<string, number>();
  private day = -1;

  constructor(
    readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** How many more calls `account` may relay today. */
  left(account: Address): number {
    this.turnDay();
    return Math.max(0, this.perDay - (this.used.get(account.toLowerCase()) ?? 0));
  }

  /**
   * Takes one of today's calls, or throws `RELAY_QUOTA`. Synchronous, so two
   * calls racing cannot both take the last one; `giveBack` returns it if the
   * call never reaches the chain.
   */
  take(account: Address): void {
    if (this.left(account) === 0) {
      throw new RequestError('RELAY_QUOTA', `you have used today's ${this.perDay} relayed calls`);
    }
    const key = account.toLowerCase();
    this.used.set(key, (this.used.get(key) ?? 0) + 1);
  }

  giveBack(account: Address): void {
    const key = account.toLowerCase();
    this.used.set(key, Math.max(0, (this.used.get(key) ?? 0) - 1));
  }

  private turnDay(): void {
    const day = Math.floor(this.now() / DAY_MS);
    if (day === this.day) return;
    this.day = day;
    this.used = new Map();
  }
}

export class SessionRelay {
  private readonly quota: DailyQuota;

  constructor(private readonly options: SessionRelayOptions) {
    this.quota = options.quota ?? new DailyQuota(options.quotaPerDay, options.now);
  }

  get delegate(): Address {
    return this.options.delegate;
  }

  get quotaPerDay(): number {
    return this.quota.perDay;
  }

  /** How many more calls `account` may relay today. */
  left(account: Address): number {
    return this.quota.left(account);
  }

  /**
   * Relays one call for `account`, the wallet the socket logged in as. A
   * socket can only ever spend its own wallet's quota and its own wallet's
   * session: the call is addressed to `account`, and the delegate recovers the
   * key from the signature against that account's own domain.
   */
  async relay(account: Address, call: RelayedCall): Promise<{ kind: SessionCallKind; tx: Hex; left: number }> {
    const kind = sessionCallKind(
      { target: call.target, value: BigInt(call.value), data: call.data },
      { escrow: this.options.escrow, account },
    );
    if (!kind) throw new RequestError('RELAY_REFUSED', 'a session key may only join a lobby or collect winnings');
    // Taken before the first await, and handed back if the call never
    // reaches the chain.
    this.quota.take(account);
    try {
      const code = await this.options.port.codeOf(account);
      if (!isDelegatedTo(code, this.options.delegate)) {
        throw new RequestError('RELAY_REFUSED', 'this wallet has not turned on one-click play');
      }
      const tx = await this.options.port.submit(account, call).catch((error: unknown) => {
        throw new RequestError('RELAY_REFUSED', `the call would fail: ${revertReason(error)}`);
      });
      return { kind, tx, left: this.left(account) };
    } catch (error) {
      this.quota.giveBack(account);
      throw error;
    }
  }
}

/**
 * Why a call would revert, for the player: the delegate's or the escrow's
 * error name where viem decoded one (`ValueCapExceeded`, `SessionExpired`,
 * `MatchFull`), and the first line of the message otherwise.
 */
export function revertReason(error: unknown): string {
  if (error instanceof RevertedError && error.cause) return revertReason(error.cause);
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
      const { errorName, args } = reverted.data;
      // `CallFailed` wraps the escrow's own revert, which says more.
      return (errorName === 'CallFailed' ? escrowErrorName(args?.[1]) : undefined) ?? errorName;
    }
  }
  const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  return message.split('\n')[0] ?? message;
}

function escrowErrorName(reason: unknown): string | undefined {
  if (typeof reason !== 'string' || reason.length < 10) return undefined;
  try {
    return decodeErrorResult({ abi: gameEscrowAbi, data: reason as Hex }).errorName;
  } catch {
    return undefined;
  }
}

/**
 * `RelayPort` over viem, sending through the relayer's own key's sender. A key
 * of its own, not the attestor's or the keeper's: it pays strangers' gas all
 * day, so it holds only what that needs, and a drained relayer stops nothing
 * else.
 */
export function viemRelayPort(options: { rpcUrl: string; chainId: number; sender: TxSender }): RelayPort {
  const client = readClient(options.chainId, options.rpcUrl);
  return {
    codeOf: (address) => client.getCode({ address }),
    submit: (address, call) =>
      // Keyed by account and session nonce: a call is relayed once, however
      // often the client asks.
      options.sender.sendAndWait(`relay:${address.toLowerCase()}:${call.nonce}`, {
        address,
        abi: sessionKeyDelegateAbi,
        functionName: 'executeWithSession',
        args: [call.target, BigInt(call.value), call.data, BigInt(call.nonce), call.signature],
      }),
  };
}
