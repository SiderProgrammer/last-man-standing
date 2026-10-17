import type { Address, Hex } from 'viem';
import { errorMessage, feeRouterAbi, gameEscrowAbi } from '@lms/protocol';
import { signerClients } from './viem.js';
import { log } from '../observability/log.js';
import { observeTx } from '../observability/metrics.js';

const logger = log.child({ component: 'fees' });

/**
 * Everything the keeper needs from the chain, as an interface, for the same
 * reason `EscrowReader` is one: the decision is the part worth testing, and it
 * should be reachable with a fake.
 */
export interface FeeRouterPort {
  /** Fees the escrow has credited the router and the router has not yet pulled. */
  credited(): Promise<bigint>;
  /** Resolves once the transaction is mined. */
  harvest(): Promise<void>;
}

export interface FeeKeeperPolicy {
  /** Credited fees, in wei, worth paying gas to harvest. */
  minHarvest: bigint;
}

export const DEFAULT_FEE_KEEPER_POLICY: FeeKeeperPolicy = {
  minHarvest: 50_000_000_000_000_000n, // 0.05 ETH
};

/** `DEFAULT_FEE_KEEPER_POLICY` with every override that is set applied over it. */
export function feeKeeperPolicy(overrides: {
  [K in keyof FeeKeeperPolicy]?: FeeKeeperPolicy[K] | undefined;
}): FeeKeeperPolicy {
  const policy = { ...DEFAULT_FEE_KEEPER_POLICY };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Object.assign(policy, { [key]: value });
  }
  return policy;
}

/**
 * Harvests `FeeRouter` on a timer, so match fees reach stakers and the
 * treasury without anyone having to remember to.
 *
 * `harvest` is open to anyone and moves fees only to where the router already
 * sends them, so this holds no authority and needs no trust: any funded key
 * will do, and if it stops, anyone else can harvest instead. It waits for
 * `minHarvest` so that gas is not spent moving dust.
 */
export class FeeKeeper {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly port: FeeRouterPort,
    private readonly policy: FeeKeeperPolicy = DEFAULT_FEE_KEEPER_POLICY,
  ) {}

  start(pollMs: number): void {
    void this.tickLogged();
    this.timer = setInterval(() => void this.tickLogged(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wei harvested, null if below the threshold, or undefined if a tick was already running. */
  async tick(): Promise<bigint | null | undefined> {
    // Overlapping ticks would double-submit the transaction.
    if (this.running) return undefined;
    this.running = true;
    try {
      const credited = await this.port.credited();
      if (credited === 0n || credited < this.policy.minHarvest) return null;
      await observeTx('harvest', { 'lms.wei': credited.toString() }, () => this.port.harvest());
      return credited;
    } finally {
      this.running = false;
    }
  }

  private async tickLogged(): Promise<void> {
    try {
      const harvested = await this.tick();
      if (harvested) logger.info('harvested', { wei: harvested });
    } catch (error) {
      logger.error('harvest failed', { error: errorMessage(error) });
    }
  }
}

export interface ViemFeeRouterOptions {
  rpcUrl: string;
  chainId: number;
  router: Address;
  /** Pays the gas. Holds no role: `harvest` is open to anyone. */
  keeperKey: Hex;
}

/** The production port: viem against a real RPC. */
export async function viemFeeRouter(options: ViemFeeRouterOptions): Promise<FeeRouterPort> {
  const { account, publicClient: client, walletClient: wallet } = signerClients(
    options.keeperKey,
    options.chainId,
    options.rpcUrl,
  );
  const router = options.router;
  const escrow = await client.readContract({ address: router, abi: feeRouterAbi, functionName: 'escrow' });

  return {
    credited: () =>
      client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'withdrawable', args: [router] }),

    async harvest() {
      const { request } = await client.simulateContract({
        account,
        address: router,
        abi: feeRouterAbi,
        functionName: 'harvest',
      });
      await client.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    },
  };
}
