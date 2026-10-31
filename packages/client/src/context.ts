import type {
  ActionValue,
  PlayStyle,
  AvatarCollectionInfo,
  AvatarEntry,
  LobbyInfo,
  MatchmakingTier,
  PublicMatchState,
  ServerMessage,
  SpokeInfo,
  StakingInfo,
  ZapInfo,
} from '@lms/protocol';
import type { Net } from './io/net.js';
import { createStore } from './store.js';
import type { Dom } from './ui/dom.js';
import type { DiscountTerms, QueueSpot } from './ui/views.js';
import type { GrantedKey } from './wallet/grant.js';
import type { Wallet } from './wallet/wallet.js';

/**
 * State every screen reads, held in one store.
 *
 * The client is one page with one socket and one set of elements, so these are
 * module singletons rather than objects threaded through every call. `app` is
 * the store's state, read-only: actions change it with `store.set`, and each
 * screen subscribes its renderers to the keys they draw (see `store.ts`). `dom` and
 * `net` are ES-module live bindings: `initContext` assigns them once at boot,
 * and every module that imported them sees the assigned value from then on.
 * Nothing may read them before `start()` has run.
 */

export interface AppState {
  wallet: Wallet | null;
  /**
   * The chain the wallet is on, mirrored from `wallet.chainId`: the wallet
   * object stays the same across a network switch, so this is the key that
   * tells subscribers it happened.
   */
  walletChainId: number;
  nonce: string;
  chainId: number;
  escrow: `0x${string}` | null;
  /** Where `PlayerAvatars` lives, per chain. Minting happens on the player's own chain. */
  avatarCollections: AvatarCollectionInfo[];
  /** 7702 delegate the account may point at, or null when the server relays no session calls. */
  sessionDelegate: `0x${string}` | null;
  /** Relayed calls each wallet may make per UTC day. */
  relayQuota: number;
  /**
   * True while the grant key holds a live on-chain session for the wallet, so
   * joins and collecting winnings go through the relayer with no prompt.
   */
  oneClick: boolean;
  /** The key the wallet granted for this login. Signs every commit and reveal. */
  grantKey: GrantedKey | null;
  /** The key the server signs commit receipts with, or null when it issues none. */
  receiptSigner: `0x${string}` | null;
  /** Signs practice rooms' receipts instead. */
  practiceReceiptSigner: `0x${string}` | null;
  /** Token payment through `ZapJoin`, or null when the server offers ETH only. */
  zap: ZapInfo | null;
  /**
   * The LMS fee discount and this wallet's LMS, read on the hub; null when
   * governance has it off or the wallet is elsewhere.
   */
  discount: DiscountTerms | null;
  /** Spoke chains a wallet may stake from, each with its `SpokeRouter`. */
  spokes: SpokeInfo[];
  /** The staked-lobby directory, as the server last sent it. */
  lobbies: { open: readonly LobbyInfo[]; live: readonly LobbyInfo[] };
  /**
   * Lobbies this browser has staked into from a spoke whose stake has not yet
   * landed on the hub, by lowercased match id. Cleared by the server's
   * `crossChain` report, or by the seat showing up in the directory.
   */
  inTransit: ReadonlySet<string>;
  /** The tiers the server matchmakes; empty when it runs no matchmaker. */
  matchmaking: readonly MatchmakingTier[];
  /** This wallet's place in the matchmaking queue, or null when it is not in it. */
  queue: QueueSpot | null;
  /**
   * Matchmade lobbies the server's queue put this wallet in, by lowercased
   * match id: the only matchmade lobbies it can take a seat in.
   */
  matched: ReadonlySet<string>;
  /** The staking vault and governor, or null when the server offers neither. */
  staking: StakingInfo | null;
  /** True when the server can write match analyses. */
  analyst: boolean;
  match: PublicMatchState | null;
  /**
   * Avatars for the current match, held here rather than pushed straight at the
   * arena: they can arrive before `Arena.mount` has resolved, and the arena is
   * rebuilt on every match switch.
   */
  avatars: readonly AvatarEntry[];
  /** Earlier play styles of this table's wallets, by lowercased address. */
  dossier: ReadonlyMap<string, PlayStyle>;
  you: number | null;
  deadline: number;
  /** Seats round 1 is still waiting to see connected. Empty once it has started. */
  waitingFor: readonly number[];
  /** Action the player has selected but not yet sealed. */
  draft: Readonly<{ action: ActionValue; target: number }> | null;
  /** Round whose commitment is already on the server. */
  committedRound: number | null;
  /** Round whose reveal is already on the server. */
  revealedRound: number | null;
  /**
   * True while the last round is being replayed. The server holds the next
   * commit clock for the same length, so the controls stay closed without
   * costing anyone decision time.
   */
  replaying: boolean;
  /**
   * A `finished` that arrived mid-replay. Settlement is never delayed on the
   * server; only *showing* the result waits, so the final kill plays before the
   * "match over" line spoils it.
   */
  pendingFinish: Extract<ServerMessage, { type: 'finished' }> | null;
}

export const store = createStore<AppState>({
  wallet: null,
  walletChainId: 0,
  nonce: '',
  chainId: 0,
  escrow: null,
  avatarCollections: [],
  sessionDelegate: null,
  relayQuota: 0,
  oneClick: false,
  grantKey: null,
  receiptSigner: null,
  practiceReceiptSigner: null,
  zap: null,
  spokes: [],
  discount: null,
  lobbies: { open: [], live: [] },
  inTransit: new Set(),
  matchmaking: [],
  queue: null,
  matched: new Set(),
  staking: null,
  analyst: false,
  match: null,
  avatars: [],
  dossier: new Map(),
  you: null,
  deadline: 0,
  waitingFor: [],
  draft: null,
  committedRound: null,
  revealedRound: null,
  replaying: false,
  pendingFinish: null,
});

export const app: Readonly<AppState> = store.state;

export let dom: Dom;
export let net: Net;

export function initContext(elements: Dom, socket: Net): void {
  dom = elements;
  net = socket;
}
