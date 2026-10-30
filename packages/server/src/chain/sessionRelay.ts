import { createPublicClient, createWalletClient, http, nonceManager, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  isDelegatedTo,
  sessionCallKind,
  sessionKeyDelegateAbi,
  type RelayedCall,
  type SessionCallKind,
} from '@lms/protocol';
import { RequestError } from '../errors.js';
import { rpcChain } from './viem.js';

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
   * it and waits for it to be mined. Throws on a revert at either stage.
   */
  submit(account: Address, call: RelayedCall): Promise<Hex>;
}

export interface SessionRelayOptions {
  port: RelayPort;
  escrow: Address;
  delegate: Address;
  /** Relayed calls per wallet per UTC day. */
  quotaPerDay: number;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class SessionRelay {
  /** Calls relayed today, by lowercased wallet. Cleared when the day turns. */
  private used = new Map<string, number>();
  private day = -1;

  constructor(private readonly options: SessionRelayOptions) {}

  get delegate(): Address {
    return this.options.delegate;
  }

  get quotaPerDay(): number {
    return this.options.quotaPerDay;
  }

  /** How many more calls `account` may relay today. */
  left(account: Address): number {
    this.turnDay();
    return Math.max(0, this.options.quotaPerDay - (this.used.get(account.toLowerCase()) ?? 0));
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
    if (this.left(account) === 0) {
      throw new RequestError('RELAY_QUOTA', `you have used today's ${this.options.quotaPerDay} relayed calls`);
    }

    // Taken before the first await, so two calls racing cannot both take the
    // last slot; handed back if the call never reaches the chain.
    const key = account.toLowerCase();
    this.used.set(key, (this.used.get(key) ?? 0) + 1);
    try {
      const code = await this.options.port.codeOf(account);
      if (!isDelegatedTo(code, this.options.delegate)) {
        throw new RequestError('RELAY_REFUSED', 'this wallet has not turned on one-click play');
      }
      const tx = await this.options.port.submit(account, call).catch((error: unknown) => {
        throw new RequestError('RELAY_REFUSED', `the call would fail: ${firstLine(error)}`);
      });
      return { kind, tx, left: this.left(account) };
    } catch (error) {
      this.used.set(key, Math.max(0, (this.used.get(key) ?? 0) - 1));
      throw error;
    }
  }

  private turnDay(): void {
    const day = Math.floor(this.now() / DAY_MS);
    if (day === this.day) return;
    this.day = day;
    this.used = new Map();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  return message.split('\n')[0] ?? message;
}

/**
 * `RelayPort` over viem, with the relayer's own key. A key of its own, not
 * the attestor's or the keeper's: it pays strangers' gas all day, so it holds
 * only what that needs, and a drained relayer stops nothing else.
 */
export function viemRelayPort(options: { rpcUrl: string; chainId: number; relayerKey: Hex }): RelayPort {
  const chain = rpcChain(options.chainId, options.rpcUrl);
  const transport = http(options.rpcUrl);
  // Calls from many players go out of one account; the nonce manager hands
  // each its own nonce instead of asking the node, which would race.
  const account = privateKeyToAccount(options.relayerKey, { nonceManager });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  return {
    codeOf: (address) => publicClient.getCode({ address }),
    async submit(address, call) {
      const { request } = await publicClient.simulateContract({
        account,
        address,
        abi: sessionKeyDelegateAbi,
        functionName: 'executeWithSession',
        args: [call.target, BigInt(call.value), call.data, BigInt(call.nonce), call.signature],
      });
      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`relayed transaction ${hash} reverted`);
      return hash;
    },
  };
}
