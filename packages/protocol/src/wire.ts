import type { ActionValue, MatchResult, PublicMatchState, RoundRecord } from './types.js';

/** Discriminated wire protocol between the PixiJS client and the game server. */
export type ClientMessage =
  | { type: 'auth'; address: `0x${string}`; signature: `0x${string}` }
  | { type: 'practice'; bots?: number }
  | { type: 'watch'; matchId: `0x${string}` }
  | { type: 'commit'; commitment: `0x${string}` }
  | { type: 'reveal'; action: ActionValue; target: number; salt: `0x${string}` }
  | { type: 'bet'; target: number; chips: number };

export type ServerMessage =
  | { type: 'hello'; nonce: string; chainId: number }
  | { type: 'authed'; address: `0x${string}` }
  | {
      type: 'state';
      state: PublicMatchState;
      you: number | null;
      deadline: number;
      chips: number;
      book: BookSnapshot;
    }
  | { type: 'round'; record: RoundRecord; lines: string[]; book: BookSnapshot; chips: number }
  | { type: 'finished'; result: MatchResult; ranking: number[]; chips: number }
  | { type: 'book'; book: BookSnapshot; chips: number }
  | { type: 'error'; code: string; message: string };

export interface BookSnapshot {
  round: number;
  pots: Record<number, number>;
  yours: Record<number, number>;
}

export const AUTH_PREFIX = 'Last Man Standing login\nnonce:';
