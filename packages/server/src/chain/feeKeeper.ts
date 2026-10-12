import { parseAbi, type Address, type Hex } from 'viem';
import {
  BUYBACK_DEADLINE_SECONDS,
  errorMessage,
  feeRouterAbi,
  gameEscrowAbi,
  minOutFor,
  v4QuoterExactInputAbi,
  VAULT_SEED_HOLDER,
  ZERO_ADDRESS,
} from '@lms/protocol';
import { signerClients } from './viem.js';

const erc20SupplyAbi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

/**
 * Everything the keeper needs from the chain, as an interface, for the same
 * reason `EscrowReader` is one: the decisions are the part worth testing, and
 * they should be reachable with a fake.
 */
export interface FeeRouterPort {
  /** Fees the escrow has credited the router and the router has not yet pulled. */
  credited(): Promise<bigint>;
  /** ETH the router holds for buybacks. */
  pendingBuyback(): Promise<bigint>;
  /** All sLMS, and the part of it locked at `VAULT_SEED_HOLDER` by the deploy script. */
  shares(): Promise<{ total: bigint; locked: bigint }>;
  /** LMS a buyback of `amountIn` would return right now. */
  quote(amountIn: bigint): Promise<bigint>;
  /** Resolves once the transaction is mined. */
  harvest(): Promise<void>;
  /** Resolves once the transaction is mined. */
  buyback(amountIn: bigint, minLmsOut: bigint, deadline: bigint): Promise<void>;
}

export interface FeeKeeperPolicy {
  /** Credited fees, in wei, worth paying gas to harvest. */
  minHarvest: bigint;
  /** Pending ETH, in wei, worth paying gas to buy back with. */
  minBuyback: bigint;
  /**
   * Largest single buyback, in wei. Smaller buys move the pool less, and a
   * sandwich around any one of them has less to take.
   */
  maxBuyback: bigint;
  /** Room for the price to move between quote and inclusion, in basis points. */
  slippageBps: number;
  /**
   * How far below the reference price a quote may be, in basis points, before
   * the keeper declines to buy. See `FeeKeeper`.
   */
  maxDeviationBps: number;
  /** Weight a new quote gets in the reference price, in basis points. */
  referenceWeightBps: number;
  /**
   * Most of the vault's shares, in basis points, that may be the locked seed
   * when buying back. A buyback raises the value of every share pro rata, so
   * this is exactly the fraction of each buyback that ends up locked forever
   * at `VAULT_SEED_HOLDER`. Until real stakers dilute the seed below it, the
   * ETH waits in the router.
   */
  maxLockedShareBps: number;
}

export const DEFAULT_FEE_KEEPER_POLICY: FeeKeeperPolicy = {
  minHarvest: 50_000_000_000_000_000n, // 0.05 ETH
  minBuyback: 50_000_000_000_000_000n, // 0.05 ETH
  maxBuyback: 1_000_000_000_000_000_000n, // 1 ETH
  slippageBps: 100,
  maxDeviationBps: 500,
  referenceWeightBps: 2_000,
  maxLockedShareBps: 100,
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

export type BuybackOutcome =
  | { kind: 'none' }
  | { kind: 'no-stakers'; lockedShareBps: number }
  | { kind: 'bought'; amountIn: bigint; quote: bigint; minLmsOut: bigint }
  | { kind: 'declined'; amountIn: bigint; price: bigint; reference: bigint }
  | { kind: 'failed'; error: string };

export interface FeeKeeperTick {
  /** Wei harvested this tick, or null if it did not harvest. */
  harvested: bigint | null;
  buyback: BuybackOutcome;
}

/** LMS per ETH, scaled by 1e18. */
const PRICE_SCALE = 10n ** 18n;

/**
 * Drives `FeeRouter`: pulls fees out of the escrow and buys LMS for stakers.
 *
 * Each tick does at most one harvest and one buyback, the buyback capped at
 * `maxBuyback`, so a large backlog is bought in steps rather than in one trade
 * that moves the pool.
 *
 * The floor on every buyback is the quote less `slippageBps`, which bounds what
 * can change between quoting and inclusion. It cannot bound a pool that was
 * already pushed before the quote: a sandwich that buys LMS first makes the
 * quote itself bad. So the keeper keeps a reference price — an exponential
 * moving average of its own quotes — and declines to buy when a quote comes in
 * more than `maxDeviationBps` below it. A one-block push moves the average only
 * by `referenceWeightBps` of the way, while a real repricing pulls it along
 * within a few ticks, after which buying resumes.
 *
 * One-sided on purpose: a quote *above* the reference means LMS got cheaper,
 * which only helps the stakers buying it.
 *
 * The reference lives in memory and starts from the first quote after a
 * restart. Sending buybacks through a private mempool would close the gap
 * properly; that is a deployment choice, not something this class can make.
 */
export class FeeKeeper {
  private reference: bigint | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly port: FeeRouterPort,
    private readonly policy: FeeKeeperPolicy = DEFAULT_FEE_KEEPER_POLICY,
    private readonly nowSeconds: () => bigint = () => BigInt(Math.floor(Date.now() / 1000)),
  ) {}

  /** The current reference price, LMS per ETH scaled by 1e18. Null until the first quote. */
  get referencePrice(): bigint | null {
    return this.reference;
  }

  start(pollMs: number): void {
    void this.tickLogged();
    this.timer = setInterval(() => void this.tickLogged(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<FeeKeeperTick | null> {
    // Overlapping ticks would double-submit transactions.
    if (this.running) return null;
    this.running = true;
    try {
      return { harvested: await this.harvest(), buyback: await this.buyback() };
    } finally {
      this.running = false;
    }
  }

  private async harvest(): Promise<bigint | null> {
    const credited = await this.port.credited();
    if (credited === 0n || credited < this.policy.minHarvest) return null;
    await this.port.harvest();
    return credited;
  }

  private async buyback(): Promise<BuybackOutcome> {
    const pending = await this.port.pendingBuyback();
    if (pending === 0n || pending < this.policy.minBuyback) return { kind: 'none' };
    const { total, locked } = await this.port.shares();
    if (total === 0n || locked * 10_000n > total * BigInt(this.policy.maxLockedShareBps)) {
      return { kind: 'no-stakers', lockedShareBps: total === 0n ? 10_000 : Number((locked * 10_000n) / total) };
    }

    const amountIn = pending < this.policy.maxBuyback ? pending : this.policy.maxBuyback;
    let quote: bigint;
    try {
      quote = await this.port.quote(amountIn);
    } catch (error) {
      // No pool yet, or no liquidity in it. The ETH waits in the router.
      return { kind: 'failed', error: errorMessage(error) };
    }

    const price = (quote * PRICE_SCALE) / amountIn;
    const reference = this.reference ?? price;
    this.reference = reference + ((price - reference) * BigInt(this.policy.referenceWeightBps)) / 10_000n;

    const floor = (reference * BigInt(10_000 - this.policy.maxDeviationBps)) / 10_000n;
    if (quote === 0n || price < floor) return { kind: 'declined', amountIn, price, reference };

    const minLmsOut = minOutFor(quote, this.policy.slippageBps);
    const deadline = this.nowSeconds() + BigInt(BUYBACK_DEADLINE_SECONDS);
    try {
      await this.port.buyback(amountIn, minLmsOut, deadline);
    } catch (error) {
      return { kind: 'failed', error: errorMessage(error) };
    }
    return { kind: 'bought', amountIn, quote, minLmsOut };
  }

  private async tickLogged(): Promise<void> {
    try {
      const result = await this.tick();
      if (!result) return;
      if (result.harvested !== null) console.log(`[fees] harvested ${result.harvested} wei`);
      const { buyback } = result;
      if (buyback.kind === 'bought') {
        console.log(`[fees] bought LMS with ${buyback.amountIn} wei (quote ${buyback.quote}, floor ${buyback.minLmsOut})`);
      } else if (buyback.kind === 'declined') {
        console.warn(
          `[fees] buyback declined: price ${buyback.price} is too far below reference ${buyback.reference}`,
        );
      } else if (buyback.kind === 'no-stakers') {
        console.log(`[fees] buyback waiting for stakers: the locked seed is ${buyback.lockedShareBps} bps of sLMS`);
      } else if (buyback.kind === 'failed') {
        console.warn('[fees] buyback failed:', buyback.error);
      }
    } catch (error) {
      console.error('[fees] tick failed:', errorMessage(error));
    }
  }
}

export interface ViemFeeRouterOptions {
  rpcUrl: string;
  chainId: number;
  router: Address;
  /** v4-periphery `V4Quoter`. */
  quoter: Address;
  /** Must be the router's `keeper`; `buyback` rejects anyone else. */
  keeperKey: Hex;
}

/**
 * The production port: viem against a real RPC.
 *
 * Resolves to null, with the reason logged, when the key is not the router's
 * keeper — every buyback would revert, so there is nothing to run.
 */
export async function viemFeeRouter(options: ViemFeeRouterOptions): Promise<FeeRouterPort | null> {
  const { account, publicClient: client, walletClient: wallet } = signerClients(
    options.keeperKey,
    options.chainId,
    options.rpcUrl,
  );
  const router = options.router;
  const read = <T>(functionName: 'keeper' | 'escrow' | 'lms' | 'vault') =>
    client.readContract({ address: router, abi: feeRouterAbi, functionName }) as Promise<T>;

  const [keeper, escrow, lms, vault] = await Promise.all([
    read<Address>('keeper'),
    read<Address>('escrow'),
    read<Address>('lms'),
    read<Address>('vault'),
  ]);
  if (keeper.toLowerCase() !== account.toLowerCase()) {
    console.warn(`[fees] ${account} is not the router's keeper (${keeper}); not running buybacks`);
    return null;
  }

  return {
    credited: () =>
      client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'withdrawable', args: [router] }),

    pendingBuyback: () => client.readContract({ address: router, abi: feeRouterAbi, functionName: 'pendingBuyback' }),

    async shares() {
      const [total, locked] = await Promise.all([
        client.readContract({ address: vault, abi: erc20SupplyAbi, functionName: 'totalSupply' }),
        client.readContract({ address: vault, abi: erc20SupplyAbi, functionName: 'balanceOf', args: [VAULT_SEED_HOLDER] }),
      ]);
      return { total, locked };
    },

    async quote(amountIn) {
      // Read every time: governance can move the router to another pool.
      const [fee, tickSpacing, hooks] = await client.readContract({
        address: router,
        abi: feeRouterAbi,
        functionName: 'pool',
      });
      const { result } = await client.simulateContract({
        address: options.quoter,
        abi: v4QuoterExactInputAbi,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            poolKey: { currency0: ZERO_ADDRESS, currency1: lms, fee, tickSpacing, hooks },
            zeroForOne: true,
            exactAmount: amountIn,
            hookData: '0x',
          },
        ],
      });
      return result[0];
    },

    async harvest() {
      const { request } = await client.simulateContract({
        account,
        address: router,
        abi: feeRouterAbi,
        functionName: 'harvest',
      });
      await client.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    },

    async buyback(amountIn, minLmsOut, deadline) {
      const { request } = await client.simulateContract({
        account,
        address: router,
        abi: feeRouterAbi,
        functionName: 'buyback',
        args: [amountIn, minLmsOut, deadline],
      });
      await client.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    },
  };
}
