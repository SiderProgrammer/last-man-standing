import { moveLogFromHistory, replayMatch } from '@lms/engine';
import type { MatchResult, PublicMatchState } from '@lms/protocol';

/** What the browser concluded after replaying a finished match itself. */
export interface Verification {
  /** True when the replay reproduces the claimed root and ranking exactly. */
  ok: boolean;
  /** History root the replay produced. */
  root: `0x${string}`;
  /** Why it failed, for the player. Absent when `ok`. */
  reason?: string;
}

/**
 * Replays a finished match from nothing but what was broadcast — the seed, the
 * rules, the seats and the published round records — and checks the result
 * the server announced against it.
 *
 * This runs the same pure kernel the server does, in the player's own browser,
 * so a result the server fabricated would not survive it: the root would
 * differ, and with it the root the attestors signed and the escrow stored.
 */
export function verifyMatch(state: PublicMatchState, claimed: MatchResult): Verification {
  const replay = replayMatch(
    {
      matchId: state.matchId,
      seats: state.players.map((player) => ({
        index: player.index,
        address: player.address,
        chainId: player.chainId,
      })),
      seed: state.seed,
      rules: state.rules,
    },
    moveLogFromHistory(state.history),
  );
  const root = replay.result.historyRoot;

  if (root.toLowerCase() !== claimed.historyRoot.toLowerCase()) {
    return { ok: false, root, reason: 'the published rounds do not hash to the announced root' };
  }
  const sameRanking =
    replay.result.ranking.length === claimed.ranking.length &&
    replay.result.ranking.every((address, i) => address.toLowerCase() === claimed.ranking[i]?.toLowerCase());
  if (!sameRanking) return { ok: false, root, reason: 'the announced ranking is not what the rounds produce' };
  return { ok: true, root };
}

/** Compares the replayed root with the one the escrow stored at settlement. */
export function matchesChain(verification: Verification, onChainRoot: `0x${string}`): boolean {
  return verification.ok && verification.root.toLowerCase() === onChainRoot.toLowerCase();
}
