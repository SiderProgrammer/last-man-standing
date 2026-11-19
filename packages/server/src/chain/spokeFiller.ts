import { decodeAbiParameters, erc20Abi, formatEther, maxUint256, type Address, type Hex } from 'viem';
import { ZERO_ADDRESS } from '@lms/consensus';
import { bridgeJoinReceiverAbi, gameEscrowAbi, spokeRouterAbi } from '@lms/contracts';
import { errorMessage, type SpokeInfo } from '@lms/api';
import { DailyQuota } from './sessionRelay.js';
import { RevertedError, type TxSender } from './txSender.js';
import { chunkedLogs, confirmedHead } from './logs.js';
import { readClient } from './viem.js';
import { fieldsOf } from '../util/envList.js';
import { exclusive, repeat } from '../util/poll.js';

/**
 * Fills players' spoke stakes on the hub, as an Across relayer would.
 *
 * A stake from a spoke is an Across deposit to `BridgeJoinReceiver` that
 * carries a message, and Across's testnet relayers leave those unfilled
 * (docs/ACROSS.md). So the server fills them itself: it watches each spoke's
 * Across SpokePool for deposits to the receiver, from any wallet, and calls
 * the hub pool's `fillRelay`, which pays the receiver and seats the player
 * exactly as an Across fill would.
 *
 * Each fill costs the filler the stake, which Across's testnet may never
 * repay. A depositor gets their spoke ETH back as hub ETH one for one, so
 * nobody profits from it, but the filler's balance is what is spent, so it
 * is capped: no stake above `maxStake`, `perDay` fills per depositor per UTC
 * day, `reserve` always kept back for gas, and no fill for a lobby that would
 * not seat the stake (closed, full, past its join window, or a smaller stake)
 * since that would only credit it on the hub. On mainnet, where Across does
 * repay, `delayMs` gives its relayers first go and leaves this as a backstop.
 */

/** A `FundsDeposited` event, as `fillRelay` takes it back. Addresses are Across's bytes32. */
export interface SpokeDeposit {
  originChainId: number;
  depositId: bigint;
  depositor: Hex;
  recipient: Hex;
  exclusiveRelayer: Hex;
  inputToken: Hex;
  outputToken: Hex;
  inputAmount: bigint;
  outputAmount: bigint;
  fillDeadline: number;
  exclusivityDeadline: number;
  message: Hex;
}

/** One spoke's Across SpokePool, read for deposits bound for the hub. */
export interface SpokeDepositSource {
  readonly chainId: number;
  head(): Promise<bigint>;
  /** Deposits to the hub in blocks `[from, to]`, in order. */
  deposits(from: bigint, to: bigint): Promise<SpokeDeposit[]>;
}

/** A lobby, as far as deciding whether a stake would take a seat in it. */
export interface FillerLobby {
  status: number;
  seatCount: number;
  maxSeats: number;
  /** Unix seconds. */
  joinDeadline: number;
  stake: bigint;
}

/** The hub, as the filler uses it. */
export interface FillerHubPort {
  /** The filler's address: what Across repays, and who an exclusive deposit may name. */
  readonly address: Address;
  /** The hub's latest block time, in Unix seconds. */
  time(): Promise<number>;
  /** ETH and WETH the filler holds on the hub. */
  funds(): Promise<bigint>;
  lobby(matchId: Hex): Promise<FillerLobby>;
  /** Wraps and approves what it lacks, then fills. Throws a `RevertedError` on a revert, as for an already filled deposit. */
  fill(deposit: SpokeDeposit): Promise<Hex>;
}

export interface SpokeFillerPolicy {
  /** The largest stake filled, in wei. Larger deposits are left for Across. */
  maxStake: bigint;
  /** Fills per depositor per UTC day. */
  perDay: number;
  /** Wei kept back for gas: no fill leaves less than this. */
  reserve: bigint;
  /** How long a deposit is left for Across's own relayers first. */
  delayMs: number;
}

export const DEFAULT_SPOKE_FILLER_POLICY: SpokeFillerPolicy = {
  maxStake: 10_000_000_000_000_000n, // 0.01 ETH
  perDay: 10,
  reserve: 5_000_000_000_000_000n, // 0.005 ETH
  delayMs: 0,
};

/** `DEFAULT_SPOKE_FILLER_POLICY` with every override that is set applied over it. */
export function spokeFillerPolicy(overrides: {
  [K in keyof SpokeFillerPolicy]?: SpokeFillerPolicy[K] | undefined;
}): SpokeFillerPolicy {
  const policy = { ...DEFAULT_SPOKE_FILLER_POLICY };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Object.assign(policy, { [key]: value });
  }
  return policy;
}

/** `GameEscrow.MatchStatus.Open`. */
const OPEN = 1;
/** Spoke blocks read back at start, so a deposit made while the server was down is still filled. */
export const FILLER_LOOKBACK_BLOCKS = 2_000n;
/** Spoke RPCs on free tiers serve narrow log ranges. */
const SPOKE_LOG_CHUNK = 1_000n;
/** A fill that fails without a revert (an RPC error) is tried this many times in all. */
const MAX_TRIES = 3;

export interface SpokeFillerOptions {
  hub: FillerHubPort;
  sources: readonly SpokeDepositSource[];
  /** `BridgeJoinReceiver` on the hub: deposits to anything else are not ours. */
  receiver: Address;
  policy?: SpokeFillerPolicy;
  /** Blocks behind each spoke's head a scan stops at, so a reorged deposit is never filled. */
  confirmations?: number;
  now?: () => number;
}

interface Pending {
  deposit: SpokeDeposit;
  key: string;
  seenAt: number;
  tries: number;
  /** Said once that the filler is short, rather than every tick. */
  warned: boolean;
}

type Outcome = 'done' | 'wait';

export class SpokeFiller {
  private readonly cursors = new Map<number, bigint>();
  private readonly queue: Pending[] = [];
  private readonly seen = new Set<string>();
  private readonly quota: DailyQuota;
  private readonly policy: SpokeFillerPolicy;
  private readonly receiver: Hex;
  private stopTimer: (() => void) | null = null;

  constructor(private readonly options: SpokeFillerOptions) {
    this.policy = options.policy ?? DEFAULT_SPOKE_FILLER_POLICY;
    this.quota = new DailyQuota(this.policy.perDay, options.now);
    this.receiver = toBytes32(options.receiver);
  }

  start(pollMs: number): void {
    this.stopTimer = repeat(() => {
      this.tick().catch((error: unknown) => console.error('[filler] tick failed:', errorMessage(error)));
    }, pollMs);
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  /** Deposits found and not yet filled or given up on. */
  get waiting(): number {
    return this.queue.length;
  }

  /** One poll: reads every spoke, then tries what is waiting. Never two at once, so no deposit is filled twice. */
  readonly tick: () => Promise<void> = exclusive(async () => {
    for (const source of this.options.sources) {
      await this.scan(source).catch((error: unknown) =>
        console.error(`[filler] chain ${source.chainId} scan failed:`, errorMessage(error)),
      );
    }
    for (const pending of [...this.queue]) {
      const outcome = await this.consider(pending).catch((error: unknown): Outcome => {
        console.error(`[filler] deposit ${pending.key}:`, errorMessage(error));
        return 'wait';
      });
      if (outcome === 'done') this.queue.splice(this.queue.indexOf(pending), 1);
    }
  });

  private async scan(source: SpokeDepositSource): Promise<void> {
    const latest = confirmedHead(await source.head(), this.options.confirmations ?? 0);
    if (latest === null) return;
    const from = this.cursors.get(source.chainId) ?? (latest > FILLER_LOOKBACK_BLOCKS ? latest - FILLER_LOOKBACK_BLOCKS : 0n);
    if (from > latest) return;
    await chunkedLogs(
      from,
      latest,
      async (start, end) => {
        for (const deposit of await source.deposits(start, end)) this.found(deposit);
        this.cursors.set(source.chainId, end + 1n);
        return [];
      },
      SPOKE_LOG_CHUNK,
    );
  }

  private found(deposit: SpokeDeposit): void {
    if (deposit.recipient.toLowerCase() !== this.receiver) return;
    const key = `${deposit.originChainId}:${deposit.depositId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.queue.push({ deposit, key, seenAt: this.now(), tries: 0, warned: false });
  }

  /** Fills `pending` if it should be now: 'done' once filled or given up on, 'wait' to look again next tick. */
  private async consider(pending: Pending): Promise<Outcome> {
    const { deposit: d, key } = pending;
    const { hub } = this.options;
    const skip = (why: string): Outcome => {
      console.log(`[filler] deposit ${key} not filled: ${why}`);
      return 'done';
    };

    if (d.outputAmount > this.policy.maxStake) {
      return skip(`${formatEther(d.outputAmount)} ETH is over the ${formatEther(this.policy.maxStake)} ETH cap`);
    }
    const join = decodeJoin(d.message);
    if (!join) return skip('its message is not a join');
    if (this.now() - pending.seenAt < this.policy.delayMs) return 'wait';

    const time = await hub.time();
    if (time >= d.fillDeadline) return skip('past its fill deadline');
    const exclusive = fromBytes32(d.exclusiveRelayer);
    if (exclusive !== ZERO_ADDRESS && exclusive !== hub.address.toLowerCase() && time <= d.exclusivityDeadline) return 'wait';

    const lobby = await hub.lobby(join.matchId);
    if (lobby.status !== OPEN || time >= lobby.joinDeadline) return skip(`lobby ${join.matchId} is not taking joins`);
    if (lobby.seatCount >= lobby.maxSeats) return skip(`lobby ${join.matchId} is full`);
    if (d.outputAmount < lobby.stake) return skip(`${formatEther(d.outputAmount)} ETH is less than the lobby's stake`);

    const depositor = fromBytes32(d.depositor) as Address;
    if (this.quota.left(depositor) === 0) return skip(`${depositor} has had today's ${this.policy.perDay} fills`);

    const funds = await hub.funds();
    if (funds < d.outputAmount + this.policy.reserve) {
      if (!pending.warned) {
        console.warn(
          `[filler] ${hub.address} holds ${formatEther(funds)} ETH on the hub: too little to fill ${key} ` +
            `(${formatEther(d.outputAmount)} ETH plus ${formatEther(this.policy.reserve)} kept for gas). Fund it.`,
        );
        pending.warned = true;
      }
      return 'wait';
    }

    this.quota.take(depositor);
    try {
      const tx = await hub.fill(d);
      console.log(`[filler] filled deposit ${key}: ${formatEther(d.outputAmount)} ETH for ${join.player} into ${join.matchId}, tx ${tx}`);
      return 'done';
    } catch (error) {
      this.quota.giveBack(depositor);
      // A revert is final: most often someone else, Across included, filled it first.
      if (error instanceof RevertedError) return skip(`the fill reverts: ${error.message}`);
      pending.tries += 1;
      if (pending.tries >= MAX_TRIES) return skip(`${MAX_TRIES} tries failed: ${errorMessage(error)}`);
      console.error(`[filler] deposit ${key} fill failed, will retry:`, errorMessage(error));
      return 'wait';
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** What a join deposit's message holds; see `SpokeRouter.joinMessage`. Null for anything else. */
export function decodeJoin(message: Hex): { matchId: Hex; player: Address; originChainId: number } | null {
  try {
    const [matchId, player, originChainId] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint32' }],
      message,
    );
    if (player === ZERO_ADDRESS) return null;
    return { matchId, player, originChainId };
  } catch {
    return null;
  }
}

/** An address as Across's bytes32, lower-cased. */
export const toBytes32 = (address: Address): Hex => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

/** Across's bytes32 back to a lower-cased address. */
export const fromBytes32 = (word: Hex): string => `0x${word.slice(-40).toLowerCase()}`;

// ----------------------------------------------------------------------- env

export interface SpokeRpc {
  chainId: number;
  router: Address;
  rpcUrl: string;
}

/**
 * The `rpcUrl` each spoke's `SPOKES` entry names, for the spokes `parseSpokes`
 * kept: what the filler needs to read their deposits. A spoke without one is
 * left out. The URL may carry an API key, so it is read here, never logged,
 * and never sent to clients with the rest of the entry.
 */
export function spokeRpcs(raw: string, spokes: readonly SpokeInfo[]): SpokeRpc[] {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : [];
  } catch {
    return []; // `parseSpokes` has already said so.
  }
  if (!Array.isArray(parsed)) return [];
  return spokes.flatMap(({ chainId, router }) => {
    const entry = parsed.map(fieldsOf).find((fields) => fields?.chainId === chainId);
    const rpcUrl = entry?.rpcUrl;
    return typeof rpcUrl === 'string' && /^https?:\/\//.test(rpcUrl) ? [{ chainId, router, rpcUrl }] : [];
  });
}

// ---------------------------------------------------------------------- viem

/** The parts of Across's SpokePool and WETH a relayer uses. */
const acrossAbi = [
  {
    type: 'event',
    name: 'FundsDeposited',
    inputs: [
      { name: 'inputToken', type: 'bytes32', indexed: false },
      { name: 'outputToken', type: 'bytes32', indexed: false },
      { name: 'inputAmount', type: 'uint256', indexed: false },
      { name: 'outputAmount', type: 'uint256', indexed: false },
      { name: 'destinationChainId', type: 'uint256', indexed: true },
      { name: 'depositId', type: 'uint256', indexed: true },
      { name: 'quoteTimestamp', type: 'uint32', indexed: false },
      { name: 'fillDeadline', type: 'uint32', indexed: false },
      { name: 'exclusivityDeadline', type: 'uint32', indexed: false },
      { name: 'depositor', type: 'bytes32', indexed: true },
      { name: 'recipient', type: 'bytes32', indexed: false },
      { name: 'exclusiveRelayer', type: 'bytes32', indexed: false },
      { name: 'message', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'fillRelay',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'relayData',
        type: 'tuple',
        components: [
          { name: 'depositor', type: 'bytes32' },
          { name: 'recipient', type: 'bytes32' },
          { name: 'exclusiveRelayer', type: 'bytes32' },
          { name: 'inputToken', type: 'bytes32' },
          { name: 'outputToken', type: 'bytes32' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'outputAmount', type: 'uint256' },
          { name: 'originChainId', type: 'uint256' },
          { name: 'depositId', type: 'uint256' },
          { name: 'fillDeadline', type: 'uint32' },
          { name: 'exclusivityDeadline', type: 'uint32' },
          { name: 'message', type: 'bytes' },
        ],
      },
      { name: 'repaymentChainId', type: 'uint256' },
      { name: 'repaymentAddress', type: 'bytes32' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

export interface ViemSpokeFillerOptions {
  hubRpcUrl: string;
  hubChainId: number;
  escrow: Address;
  /** The filler's own key: every fill spends its ETH. */
  sender: TxSender;
  spokes: readonly SpokeRpc[];
}

/**
 * The production ports. Reads where everything is from the chain: the
 * receiver from each `SpokeRouter`, the hub pool and WETH from the receiver,
 * each spoke's pool from its router. A spoke whose router names another hub
 * or receiver is left out with a warning. Null when no spoke is usable.
 */
export async function viemSpokeFiller(
  options: ViemSpokeFillerOptions,
): Promise<{ hub: FillerHubPort; sources: SpokeDepositSource[]; receiver: Address } | null> {
  const { hubChainId, sender, escrow } = options;
  let receiver: Address | null = null;
  const sources: SpokeDepositSource[] = [];

  for (const spoke of options.spokes) {
    const client = readClient(spoke.chainId, spoke.rpcUrl);
    const read = <T>(functionName: 'spokePool' | 'hubReceiver' | 'hubChainId') =>
      client.readContract({ address: spoke.router, abi: spokeRouterAbi, functionName }) as Promise<T>;
    try {
      const [pool, hubReceiver, hub] = await Promise.all([
        read<Address>('spokePool'),
        read<Address>('hubReceiver'),
        read<bigint>('hubChainId'),
      ]);
      if (Number(hub) !== hubChainId) throw new Error(`its router bridges to chain ${hub}`);
      if (receiver && hubReceiver.toLowerCase() !== receiver.toLowerCase()) {
        throw new Error(`its router pays ${hubReceiver}, not ${receiver}`);
      }
      receiver = hubReceiver;
      sources.push(spokeSource(spoke.chainId, client, pool, hubChainId));
    } catch (error) {
      console.warn(`[filler] leaving out chain ${spoke.chainId}: ${errorMessage(error)}`);
    }
  }
  if (!receiver || sources.length === 0) return null;

  const hubClient = readClient(hubChainId, options.hubRpcUrl);
  const [hubPool, weth] = await Promise.all([
    hubClient.readContract({ address: receiver, abi: bridgeJoinReceiverAbi, functionName: 'spokePool' }) as Promise<Address>,
    hubClient.readContract({ address: receiver, abi: bridgeJoinReceiverAbi, functionName: 'weth' }) as Promise<Address>,
  ]);
  const me = sender.address;
  const wethOf = (functionName: 'balanceOf' | 'allowance', args: readonly [Address] | readonly [Address, Address]) =>
    hubClient.readContract({ address: weth, abi: erc20Abi, functionName, args } as never) as Promise<bigint>;

  const hub: FillerHubPort = {
    address: me,
    time: async () => Number((await hubClient.getBlock()).timestamp),
    funds: async () => (await hubClient.getBalance({ address: me })) + (await wethOf('balanceOf', [me])),
    async lobby(matchId) {
      const info = await hubClient.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getMatch', args: [matchId] });
      return {
        status: Number(info.status),
        seatCount: Number(info.seatCount),
        maxSeats: Number(info.maxSeats),
        joinDeadline: Number(info.joinDeadline),
        stake: info.stake,
      };
    },
    async fill(d) {
      const key = `${d.originChainId}:${d.depositId}`;
      const held = await wethOf('balanceOf', [me]);
      if (held < d.outputAmount) {
        await sender.sendAndWait(`fillWrap:${key}`, { address: weth, abi: acrossAbi, functionName: 'deposit', value: d.outputAmount - held });
      }
      if ((await wethOf('allowance', [me, hubPool])) < d.outputAmount) {
        await sender.sendAndWait(`fillApprove:${key}`, { address: weth, abi: erc20Abi, functionName: 'approve', args: [hubPool, maxUint256] });
      }
      const { originChainId, ...relay } = d;
      return sender.sendAndWait(`fill:${key}`, {
        address: hubPool,
        abi: acrossAbi,
        functionName: 'fillRelay',
        args: [{ ...relay, originChainId: BigInt(originChainId) }, BigInt(hubChainId), toBytes32(me)],
      });
    },
  };
  return { hub, sources, receiver };
}

function spokeSource(
  chainId: number,
  client: ReturnType<typeof readClient>,
  pool: Address,
  hubChainId: number,
): SpokeDepositSource {
  return {
    chainId,
    head: () => client.getBlockNumber(),
    async deposits(fromBlock, toBlock) {
      const logs = await client.getContractEvents({
        address: pool,
        abi: acrossAbi,
        eventName: 'FundsDeposited',
        args: { destinationChainId: BigInt(hubChainId) },
        fromBlock,
        toBlock,
      });
      return logs.flatMap(({ args: a }) =>
        a.depositId === undefined ||
        a.depositor === undefined ||
        a.recipient === undefined ||
        a.exclusiveRelayer === undefined ||
        a.inputToken === undefined ||
        a.outputToken === undefined ||
        a.inputAmount === undefined ||
        a.outputAmount === undefined ||
        a.fillDeadline === undefined ||
        a.exclusivityDeadline === undefined ||
        a.message === undefined
          ? []
          : [
              {
                originChainId: chainId,
                depositId: a.depositId,
                depositor: a.depositor,
                recipient: a.recipient,
                exclusiveRelayer: a.exclusiveRelayer,
                inputToken: a.inputToken,
                outputToken: a.outputToken,
                inputAmount: a.inputAmount,
                outputAmount: a.outputAmount,
                fillDeadline: a.fillDeadline,
                exclusivityDeadline: a.exclusivityDeadline,
                message: a.message,
              },
            ],
      );
    },
  };
}
