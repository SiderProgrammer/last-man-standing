import { parseEventLogs, type Address, type Hex } from 'viem';
import { addressKey } from '@lms/consensus';
import { gameEscrowAbi } from '@lms/contracts';
import type { LobbyInfo } from '@lms/api';
import { RequestError } from '../errors.js';
import { revertReason, type DailyQuota } from './sessionRelay.js';
import type { TxSender } from './txSender.js';
import { readClient } from './viem.js';

/**
 * Opens lobbies on the hub for players, and pays the hub gas.
 *
 * `GameEscrow.createMatch` takes no stake and anyone may call it, but only on
 * the hub. A player on a spoke can stake into a lobby from where they are,
 * through `SpokeRouter`, yet could not open one without gas on the hub. The
 * server opens it for them and hands back its id; they then stake into it
 * from their own chain like any other lobby. Opening seats nobody.
 *
 * What the server guards is its own gas, as for relayed calls: each opening
 * counts against the wallet's daily quota, it is simulated before it is sent
 * (so a stake or size out of range costs a read, not a transaction), and a
 * wallet has at most one lobby at a time that was opened for it and that it
 * has not staked into yet. That last one is what stops a wallet spending its
 * whole quota on empty lobbies at once.
 */
export interface LobbyOpenerPort {
  /** Simulates `createMatch` from the relayer, then sends it and waits. Throws on a revert at either stage. */
  open(stake: bigint, seats: number, key: string): Promise<{ tx: Hex; matchId: Hex }>;
}

export interface LobbyOpenerOptions {
  port: LobbyOpenerPort;
  quota: DailyQuota;
  /** Every lobby on the chain, open or live, as the directory has it. */
  lobbies: () => readonly LobbyInfo[];
  now?: () => number;
}

/**
 * How long a lobby opened for a wallet stops it opening another, unless it
 * staked into it sooner: as long as a lobby takes joins, `joinWindow` on the
 * deployed config. By then it is either seated or about to be cancelled.
 */
export const OPEN_HOLD_MS = 10 * 60_000;

/** A uint128, the escrow's stake type. */
const MAX_STAKE = 2n ** 128n - 1n;

export class LobbyOpener {
  /** The lobby last opened for each wallet, by lower-cased address; `matchId` null while it is being opened. */
  private readonly opened = new Map<string, { matchId: Hex | null; at: number }>();
  private count = 0;

  constructor(private readonly options: LobbyOpenerOptions) {}

  async open(account: Address, stakeWei: string, seats: number): Promise<{ tx: Hex; matchId: Hex; left: number }> {
    const stake = BigInt(stakeWei);
    if (stake === 0n || stake > MAX_STAKE) throw new RequestError('RELAY_REFUSED', 'that stake is out of range');

    const key = addressKey(account);
    this.requireNoneWaiting(account);
    // Taken before anything is awaited, so two requests racing cannot both open one.
    this.opened.set(key, { matchId: null, at: this.now() });

    const { quota, port } = this.options;
    try {
      const { tx, matchId } = await quota.spend(account, () =>
        port.open(stake, seats, `openLobby:${key}:${(this.count += 1)}`).catch((error: unknown) => {
          throw new RequestError('RELAY_REFUSED', `the lobby would not open: ${revertReason(error)}`);
        }),
      );
      this.opened.set(key, { matchId, at: this.now() });
      console.log(`[lobbies] opened ${matchId} for ${account}`);
      return { tx, matchId, left: quota.left(account) };
    } catch (error) {
      this.opened.delete(key);
      throw error;
    }
  }

  /**
   * Refuses while the lobby last opened for `account` still waits for its
   * stake: being opened, not yet in the directory, or open without it seated.
   */
  private requireNoneWaiting(account: Address): void {
    const key = addressKey(account);
    const last = this.opened.get(key);
    if (!last) return;
    if (last.matchId === null) throw new RequestError('RELAY_REFUSED', 'a lobby is already being opened for you');
    const age = this.now() - last.at;
    if (age >= OPEN_HOLD_MS) return;
    const id = addressKey(last.matchId);
    const lobby = this.options.lobbies().find((entry) => addressKey(entry.matchId) === id);
    const done = lobby && (lobby.status !== 'open' || lobby.players.some((seat) => addressKey(seat.address) === key));
    if (done) return;
    const minutes = Math.max(1, Math.ceil((OPEN_HOLD_MS - age) / 60_000));
    throw new RequestError(
      'RELAY_REFUSED',
      `the lobby opened for you is still waiting for your stake: stake into it, or open another in ${minutes} min`,
    );
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** `LobbyOpenerPort` over viem, sending with the session relayer's key: the same quota limits it. */
export function viemLobbyOpenerPort(options: {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  sender: TxSender;
}): LobbyOpenerPort {
  const client = readClient(options.chainId, options.rpcUrl);
  return {
    async open(stake, seats, key) {
      const tx = await options.sender.sendAndWait(key, {
        address: options.escrow,
        abi: gameEscrowAbi,
        functionName: 'createMatch',
        args: [stake, seats],
      });
      const receipt = await client.getTransactionReceipt({ hash: tx });
      const [created] = parseEventLogs({ abi: gameEscrowAbi, logs: receipt.logs, eventName: 'MatchCreated' });
      if (!created) throw new Error(`createMatch ${tx} opened no lobby`);
      return { tx, matchId: created.args.matchId };
    },
  };
}
