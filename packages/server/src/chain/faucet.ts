import type { Address, Hex } from 'viem';
import { addressKey } from '@lms/consensus';
import { lmsFaucetAbi } from '@lms/contracts';
import type { ServerMessage } from '@lms/api';
import { revertReason } from './sessionRelay.js';
import type { TxSender } from './txSender.js';
import { readClient } from './viem.js';

/**
 * Gives every wallet that signs in its scoop of testnet LMS, from the
 * `LmsFaucet` that `Deploy.s.sol` funds off Base mainnet, and pays the gas.
 *
 * `drip` is open to anyone and pays each address once; the contract enforces
 * that. What the server guards is its own gas and the jar:
 *
 *   * only a wallet that signed in is dripped, once it has some ETH on the
 *     hub. A guest's key, or an address made up to farm the jar, has none,
 *     while a tester needs some to play at all. One without ETH is asked
 *     again on its next sign-in;
 *   * an address the faucet already paid costs one read, then none until a
 *     restart;
 *   * once the jar is empty, nothing more is tried until a restart.
 *
 * Nothing here throws to the caller: a failed drip is logged, and the wallet
 * is tried again on its next sign-in.
 */
export interface FaucetPort {
  /** Whether the faucet has paid `account` already. */
  dripped(account: Address): Promise<boolean>;
  /** How many more addresses the faucet can pay. */
  scoopsLeft(): Promise<bigint>;
  /** `account`'s ETH on the hub, in wei. */
  ethOf(account: Address): Promise<bigint>;
  /** The scoop: LMS sent, and LMS staked as sLMS. */
  scoop(): Promise<{ liquid: bigint; staked: bigint }>;
  /** Simulates `drip(account)`, then sends it and waits. Throws on a revert. */
  drip(account: Address): Promise<Hex>;
}

export interface FaucetOptions {
  port: FaucetPort;
  /** Tells the wallet's sockets it was paid. */
  notify: (address: Address, message: ServerMessage) => void;
}

/** What one sign-in came to. Returned for tests; `onLogin` ignores it. */
export type DripOutcome = 'dripped' | 'already' | 'no-eth' | 'empty' | 'busy' | 'failed';

export class Faucet {
  /** Wallets the faucet has paid, by lower-cased address: never asked about again. */
  private readonly paid = new Set<string>();
  /** Wallets being looked at or dripped right now, so two sockets signing in at once send one drip. */
  private readonly inFlight = new Set<string>();
  private empty = false;
  private scoopRead: Promise<{ liquid: bigint; staked: bigint }> | null = null;

  constructor(private readonly options: FaucetOptions) {}

  /** Called on every sign-in. Never throws, and never holds the sign-in up. */
  onLogin(address: Address): void {
    void this.maybeDrip(address);
  }

  async maybeDrip(address: Address): Promise<DripOutcome> {
    const key = addressKey(address);
    if (this.empty) return 'empty';
    if (this.paid.has(key)) return 'already';
    if (this.inFlight.has(key)) return 'busy';
    this.inFlight.add(key);
    const { port } = this.options;
    try {
      if (await port.dripped(address)) {
        this.paid.add(key);
        return 'already';
      }
      if ((await port.ethOf(address)) === 0n) return 'no-eth';
      if ((await port.scoopsLeft()) === 0n) {
        this.empty = true;
        console.warn('[faucet] empty: no more wallets get testnet LMS');
        return 'empty';
      }
      const scoop = await this.scoop();
      const tx = await port.drip(address);
      this.paid.add(key);
      console.log(`[faucet] ${address}: ${tx}`);
      this.options.notify(address, {
        type: 'dripped',
        liquid: scoop.liquid.toString(),
        staked: scoop.staked.toString(),
        tx,
      });
      return 'dripped';
    } catch (error) {
      console.warn(`[faucet] could not drip ${address}: ${revertReason(error)}`);
      return 'failed';
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Read once: the amounts are immutable. A failed read is tried again next time. */
  private scoop(): Promise<{ liquid: bigint; staked: bigint }> {
    this.scoopRead ??= this.options.port.scoop().catch((error: unknown) => {
      this.scoopRead = null;
      throw error;
    });
    return this.scoopRead;
  }
}

/** `FaucetPort` over viem, sending with the session relayer's key, which pays strangers' gas already. */
export function viemFaucetPort(options: { rpcUrl: string; chainId: number; faucet: Address; sender: TxSender }): FaucetPort {
  const client = readClient(options.chainId, options.rpcUrl);
  const contract = { address: options.faucet, abi: lmsFaucetAbi } as const;
  return {
    dripped: (account) => client.readContract({ ...contract, functionName: 'dripped', args: [account] }),
    scoopsLeft: () => client.readContract({ ...contract, functionName: 'scoopsLeft' }),
    ethOf: (account) => client.getBalance({ address: account }),
    scoop: async () => {
      const [liquid, staked] = await Promise.all([
        client.readContract({ ...contract, functionName: 'liquidAmount' }),
        client.readContract({ ...contract, functionName: 'stakedAmount' }),
      ]);
      return { liquid, staked };
    },
    // Keyed by address: a wallet is dripped once, however often it signs in.
    drip: (account) =>
      options.sender.sendAndWait(`faucet:${addressKey(account)}`, {
        address: options.faucet,
        abi: lmsFaucetAbi,
        functionName: 'drip',
        args: [account],
      }),
  };
}
