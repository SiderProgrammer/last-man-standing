import { keccak256, stringToHex } from 'viem';
import { auditTranscript, moveLogFromHistory, replayMatch, type Audit, type AuditOptions, type ChainRecord, type OwnMove } from '@lms/engine';
import { canonicalJson, type MatchResult, type PublicMatchState, type Transcript } from '@lms/consensus';

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

/**
 * The full check, once the result is proposed on-chain: fetch the transcript
 * by the hash the escrow stored, then audit it against the escrow's seed,
 * rules, seats and result, every player's signatures, and this browser's own
 * sealed moves and receipts (`auditTranscript`).
 *
 * The server only serves the transcript; it cannot make one pass. A
 * transcript that does not hash to the stored hash fails like any other.
 */
export async function verifyOnChain(options: {
  chain: ChainRecord;
  /** The game server's HTTP origin. */
  server: string;
  own?: AuditOptions['own'];
  verifyWallet?: AuditOptions['verifyWallet'];
  fetcher?: typeof fetch;
}): Promise<{ audit: Audit; transcript: Transcript | null }> {
  const { chain } = options;
  let transcript: Transcript;
  try {
    const response = await (options.fetcher ?? fetch)(`${options.server}/transcripts/${chain.transcriptHash}`);
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    transcript = (await response.json()) as Transcript;
  } catch (error) {
    const reason = `the transcript the escrow names could not be fetched: ${error instanceof Error ? error.message : String(error)}`;
    return { audit: { ok: false, problems: [reason], root: '0x' }, transcript: null };
  }
  const audit = await auditTranscript(transcript, {
    chain,
    ...(options.own ? { own: options.own } : {}),
    ...(options.verifyWallet ? { verifyWallet: options.verifyWallet } : {}),
  });
  return { audit, transcript };
}

/**
 * What a player submits with a dispute: what is wrong, and their own record
 * of the match — every move they sealed, with its salt and the server's
 * receipt. The dispute itself carries only `evidenceHash(bundle)`; the bundle
 * goes to the guardian, who can check it against that hash.
 */
export interface EvidenceBundle {
  version: 1;
  matchId: `0x${string}`;
  /** The transcript the escrow stored, which the problems are about. */
  transcriptHash: `0x${string}`;
  seat: number | null;
  problems: string[];
  /** This browser's sealed moves, by round. */
  moves: Array<{ round: number } & OwnMove>;
}

export function evidenceBundle(
  matchId: `0x${string}`,
  transcriptHash: `0x${string}`,
  audit: Audit,
  own: AuditOptions['own'] | null,
): EvidenceBundle {
  const moves = [...(own?.moves ?? new Map<number, OwnMove>())]
    .sort(([a], [b]) => a - b)
    .map(([round, move]) => ({ round, ...move }));
  return { version: 1, matchId, transcriptHash, seat: own?.seat ?? null, problems: audit.problems, moves };
}

/** keccak256 of the bundle's canonical JSON: what `dispute` records. */
export function evidenceHash(bundle: EvidenceBundle): `0x${string}` {
  return keccak256(stringToHex(canonicalJson(bundle)));
}
