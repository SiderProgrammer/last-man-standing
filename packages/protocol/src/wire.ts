import type { AvatarEntry } from './avatars.js';
import type { ActionValue, MatchResult, PublicMatchState, RoundRecord } from './types.js';

/** Discriminated wire protocol between the PixiJS client and the game server. */
export type ClientMessage =
  | { type: 'auth'; address: `0x${string}`; signature: `0x${string}` }
  | { type: 'lobbies' }
  | { type: 'practice'; bots?: number }
  | { type: 'watch'; matchId: `0x${string}` }
  | { type: 'commit'; commitment: `0x${string}` }
  | { type: 'reveal'; action: ActionValue; target: number; salt: `0x${string}` }
  | { type: 'bet'; target: number; chips: number }
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
    };

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
    }
  | { type: 'authed'; address: `0x${string}` }
  | { type: 'lobbies'; open: LobbyInfo[]; live: LobbyInfo[] }
  | {
      type: 'state';
      state: PublicMatchState;
      you: number | null;
      deadline: number;
      chips: number;
      book: BookSnapshot;
    }
  | {
      type: 'round';
      record: RoundRecord;
      lines: string[];
      book: BookSnapshot;
      chips: number;
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
  | { type: 'finished'; result: MatchResult; ranking: number[]; chips: number }
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

/** Per-round elimination book, from the perspective of one viewer. */
export interface BookSnapshot {
  round: number;
  pots: Record<number, number>;
  yours: Record<number, number>;
}

export const AUTH_PREFIX = 'Last Man Standing login\nnonce:';
