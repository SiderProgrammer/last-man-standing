import type { AvatarEntry } from './chain/avatars.js';
import type { ZapInfo } from './chain/zap.js';
import type { StakingInfo } from './chain/governance.js';
import type { ActionValue, MatchResult, PublicMatchState, RoundRecord } from './game/types.js';
import type { PlayStyle } from './game/style.js';

/** Largest client frame the server will parse. Every legitimate message is far smaller. */
export const MAX_CLIENT_FRAME_BYTES = 8 * 1024;

/**
 * Which match and round a move was made for. Optional on the wire for older
 * clients, but every current client sends it: without it the server can only
 * assume a move is for the round in progress, so a commit computed for an
 * earlier round — delayed in flight, or queued while offline and flushed on
 * reconnect — was accepted as this round's and could then never be opened.
 * With it, such a move is refused with an error naming the round.
 */
export interface MoveAim {
  matchId?: `0x${string}`;
  round?: number;
}

/** Discriminated wire protocol between the PixiJS client and the game server. */
export type ClientMessage =
  | { type: 'auth'; address: `0x${string}`; signature: `0x${string}` }
  | { type: 'lobbies' }
  | { type: 'practice'; bots?: number }
  | { type: 'watch'; matchId: `0x${string}` }
  | ({
      type: 'commit';
      commitment: `0x${string}`;
      /**
       * Opt-in: the move behind the commitment, for the server to reveal on
       * the player's behalf if their socket drops before the reveal window.
       * It must open `commitment` or the commit is refused. The cost is that
       * the server learns the move a phase earlier than it otherwise would.
       */
      hold?: { action: ActionValue; target: number; salt: `0x${string}` };
    } & MoveAim)
  | ({ type: 'reveal'; action: ActionValue; target: number; salt: `0x${string}` } & MoveAim)
  /**
   * A call the player's session key authorised, for the server to submit and
   * pay for. The signature is the whole authority — the server cannot alter
   * the call without invalidating it, and the delegate enforces the session's
   * scope on-chain regardless of what the server does with it.
   */
  | {
      type: 'relay';
      target: `0x${string}`;
      /** Native value in wei, decimal string. */
      value: string;
      data: `0x${string}`;
      /** The account's session nonce, decimal string. */
      nonce: string;
      signature: `0x${string}`;
    }
  /**
   * Asks the server to push the authenticated account's escrow balance to it,
   * paying the gas. `GameEscrow.withdrawFor` only ever pays the account
   * itself, so this needs no signature beyond the login.
   */
  | { type: 'collect' };

export type ServerMessage =
  | {
      type: 'hello';
      nonce: string;
      chainId: number;
      escrow: `0x${string}` | null;
      /**
       * Where `PlayerAvatars` is deployed, per chain. The client picks the one
       * matching the chain its wallet is on, because minting happens where the
       * player already is rather than on the hub.
       */
      avatarCollections: AvatarCollectionInfo[];
      /**
       * `SessionKeyDelegate` on the hub chain, or null when the server cannot
       * verify ERC-1271 logins. The client offers one-click play only when this
       * is present, because a session-key login is worthless if the gateway
       * would reject it.
       */
      sessionDelegate: `0x${string}` | null;
      /**
       * Token payment through `ZapJoin`, or null when this server offers none.
       * Lives on the hub, like the escrow it pays into.
       */
      zap: ZapInfo | null;
      /** True when the server will pay the gas to push payouts (`collect`). */
      collect: boolean;
      /**
       * The staking vault and governor, or null when this server
       * has none configured. Both live on the hub, like the escrow whose fees
       * fund them.
       */
      staking: StakingInfo | null;
    }
  | { type: 'authed'; address: `0x${string}` }
  | { type: 'lobbies'; open: LobbyInfo[]; live: LobbyInfo[] }
  | {
      type: 'state';
      state: PublicMatchState;
      you: number | null;
      deadline: number;
    }
  | {
      type: 'round';
      record: RoundRecord;
      lines: string[];
      /**
       * How long the server holds the next commit clock while clients replay
       * this round. A relative duration rather than a timestamp, so the client
       * never has to reconcile its clock with the server's.
       */
      replayMs: number;
    }
  /**
   * Avatars for a match's seats. Sent separately from `state` because it
   * arrives later — the seats are known the moment the room opens, the NFT
   * metadata only after a chain read and an IPFS fetch — and because keeping
   * cosmetics out of the match snapshot keeps them out of the engine.
   */
  | { type: 'avatars'; matchId: `0x${string}`; entries: AvatarEntry[] }
  /**
   * What the table's wallets have done in earlier settled matches, for the
   * reads panel. Sent apart from `state` for the same reason as `avatars`: it
   * arrives after a database read, and it is not part of the match.
   */
  | { type: 'dossier'; matchId: `0x${string}`; entries: Array<{ address: `0x${string}`; style: PlayStyle }> }
  | { type: 'finished'; result: MatchResult; ranking: number[] }
  /**
   * The settlement transaction for a finished match, or null if it could not
   * be submitted (the escrow then refunds everyone after its deadline).
   * Practice matches never settle and never get one.
   */
  | { type: 'settled'; matchId: `0x${string}`; tx: `0x${string}` | null }
  /** Transaction hash of a relayed session call. */
  | { type: 'relayed'; hash: `0x${string}` }
  | { type: 'error'; code: string; message: string };

/** A `PlayerAvatars` deployment, as advertised to the client. */
export interface AvatarCollectionInfo {
  chainId: number;
  address: `0x${string}`;
}

/** A seat in a lobby that has not started yet. */
export interface LobbySeat {
  address: `0x${string}`;
  /**
   * EVM chain the stake was placed on, already normalised out of the
   * transport's id space. See `normaliseOriginChainId`.
   */
  chainId: number;
}

/** A lobby as advertised to the client. `stake` is wei in decimal string form. */
export interface LobbyInfo {
  matchId: `0x${string}`;
  stake: string;
  seatCount: number;
  maxSeats: number;
  minSeats: number;
  /** Unix seconds after which the lobby can be locked or cancelled. */
  joinDeadline: number;
  status: 'open' | 'pending' | 'live';
  players: LobbySeat[];
}

export const AUTH_PREFIX = 'Last Man Standing login\nnonce:';
