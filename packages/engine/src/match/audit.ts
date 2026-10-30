import { encodeAbiParameters, keccak256, recoverTypedDataAddress, verifyTypedData, type TypedDataDefinition } from 'viem';
import {
  Action,
  NO_COMMITMENT,
  addressKey,
  commitMove,
  commitTypedData,
  grantTypedData,
  hashRules,
  hashTranscript,
  revealTypedData,
  type ActionValue,
  type SessionGrant,
  type Transcript,
} from '@lms/protocol';
import { moveLogFromHistory, replayMatch } from './replay.js';

/**
 * What the escrow says about a proposed match. Everything a transcript is
 * checked against comes from here, never from the server that wrote it.
 */
export interface ChainRecord {
  /** The seed `fulfillRandomness` stored, which `MatchStarted` announced. */
  seed: `0x${string}`;
  /** The rules digest the lobby was opened under. */
  rulesHash: `0x${string}`;
  /** `getSeats`: seat index is array index. */
  seats: readonly `0x${string}`[];
  rounds: number;
  historyRoot: `0x${string}`;
  /** `keccak256(abi.encode(ranking))`, as `settle` stored it. */
  rankingHash: `0x${string}`;
  transcriptHash: `0x${string}`;
}

/** A move this browser sealed, as it remembers it. */
export interface OwnMove {
  action: ActionValue;
  target: number;
  salt: `0x${string}`;
  /** The server's receipt for the commitment, if one came back. */
  receipt?: { receivedAt: number; signature: `0x${string}` };
  /** True once the reveal was sent, or handed to the server to hold. */
  revealed?: boolean;
}

export interface AuditOptions {
  /** What the escrow stored. Omitted, the transcript is checked only against itself. */
  chain?: ChainRecord;
  /** The auditor's own seat and the moves it remembers sealing, by round. */
  own?: { seat: number; moves: ReadonlyMap<number, OwnMove> };
  /**
   * Checks a wallet's signature over a grant. Defaults to offline recovery,
   * which accepts EOAs only; pass an RPC-backed one to accept contract wallets.
   */
  verifyWallet?: (args: TypedDataDefinition & { address: `0x${string}`; signature: `0x${string}` }) => Promise<boolean>;
}

export interface Audit {
  /** True when nothing below was found. */
  ok: boolean;
  /** Each thing wrong, in words a player can act on. Empty when `ok`. */
  problems: string[];
  /** The history root the replay produced. */
  root: `0x${string}`;
}

/**
 * Checks a finished match from its transcript alone, against what the chain
 * stored, without trusting the server that produced either:
 *
 * - the transcript hashes to the hash the attestors signed, and names the
 *   seed, rules and seats the escrow holds;
 * - replaying its moves through the engine gives every round hash, the root
 *   and the ranking that were signed;
 * - every reveal opens its commitment;
 * - every player's commit and reveal is signed by a key that player's wallet
 *   granted, for that match, round and seat;
 * - and, for the auditor's own seat, the record matches what this browser
 *   sealed: a commitment it holds a receipt for is there, and a reveal it
 *   sent was counted.
 *
 * A failure is not proof of fraud on its own (a browser can lose its
 * storage), but each is something a player can dispute and the guardian can
 * check.
 */
export async function auditTranscript(transcript: Transcript, options: AuditOptions = {}): Promise<Audit> {
  const problems: string[] = [];
  const { matchId, seats, result } = transcript;

  const replay = replayMatch(
    { matchId, seats, seed: transcript.seed, rules: transcript.rules },
    moveLogFromHistory(transcript.rounds.map((round) => round.record)),
  );
  const root = replay.result.historyRoot;

  const chain = options.chain;
  if (chain) {
    if (hashTranscript(transcript).toLowerCase() !== chain.transcriptHash.toLowerCase()) {
      problems.push('the transcript does not hash to the one the escrow stored');
    }
    if (transcript.seed.toLowerCase() !== chain.seed.toLowerCase()) problems.push('the seed is not the one the oracle delivered');
    if (hashRules(transcript.rules).toLowerCase() !== chain.rulesHash.toLowerCase()) {
      problems.push('the rules are not the ones the lobby was opened under');
    }
    const sameSeats =
      seats.length === chain.seats.length && seats.every((seat, i) => addressKey(seat.address) === addressKey(chain.seats[i] ?? '0x'));
    if (!sameSeats) problems.push('the seats are not the ones that staked');
    if (result.historyRoot.toLowerCase() !== chain.historyRoot.toLowerCase() || result.rounds !== chain.rounds) {
      problems.push('the result is not the one proposed on-chain');
    }
    if (rankingHash(result.ranking).toLowerCase() !== chain.rankingHash.toLowerCase()) {
      problems.push('the ranking is not the one proposed on-chain');
    }
  }

  if (root.toLowerCase() !== result.historyRoot.toLowerCase() || replay.result.rounds !== result.rounds) {
    problems.push('the rounds do not replay to the signed history root');
  }
  const sameRanking =
    replay.result.ranking.length === result.ranking.length &&
    replay.result.ranking.every((address, i) => addressKey(address) === addressKey(result.ranking[i] ?? '0x'));
  if (!sameRanking) problems.push('the ranking is not what the rounds produce');
  replay.rounds.forEach((round, i) => {
    const published = transcript.rounds[i]?.record.hash ?? '0x';
    if (round.hash.toLowerCase() !== published.toLowerCase()) problems.push(`round ${round.round} does not hash to its published hash`);
  });

  problems.push(...(await checkSignatures(transcript, options)));
  if (options.own) problems.push(...checkOwnMoves(transcript, options.own));

  return { ok: problems.length === 0, problems, root };
}

const RANKING_ABI = [{ type: 'address[]' }] as const;

/** `keccak256(abi.encode(ranking))`, as `GameEscrow.settle` stores it. */
export function rankingHash(ranking: readonly `0x${string}`[]): `0x${string}` {
  return keccak256(encodeAbiParameters(RANKING_ABI, [[...ranking]]));
}

/** Every grant, commit and reveal signature, against the seats that made them. */
async function checkSignatures(transcript: Transcript, options: AuditOptions): Promise<string[]> {
  const problems: string[] = [];
  const { matchId, chainId } = transcript;
  const bots = new Set(transcript.botSeats);
  const verifyWallet = options.verifyWallet ?? ((args) => verifyTypedData(args).catch(() => false));

  // Session key -> the grant that names it, once its wallet's signature checks out.
  const grants = new Map<string, SessionGrant>();
  const seated = new Set(transcript.seats.map((seat) => addressKey(seat.address)));
  for (const signed of transcript.grants) {
    const { grant } = signed;
    if (!seated.has(addressKey(grant.wallet))) {
      problems.push(`a grant is for ${grant.wallet}, who has no seat`);
      continue;
    }
    if (grant.chainId !== chainId) problems.push(`the grant to ${grant.sessionKey} is for another chain`);
    const valid = await verifyWallet({ address: grant.wallet, ...grantTypedData(grant), signature: signed.signature });
    if (!valid) {
      problems.push(`the grant to ${grant.sessionKey} is not signed by ${grant.wallet}`);
      continue;
    }
    grants.set(addressKey(grant.sessionKey), grant);
  }

  /** Who signed `data`, if it was a key the seat's own wallet granted. */
  const signedBySeat = async (seat: number, data: TypedDataDefinition, signature: `0x${string}`): Promise<boolean> => {
    let signer: `0x${string}`;
    try {
      signer = await recoverTypedDataAddress({ ...data, signature });
    } catch {
      return false;
    }
    const grant = grants.get(addressKey(signer));
    const wallet = transcript.seats[seat]?.address;
    return grant !== undefined && wallet !== undefined && addressKey(grant.wallet) === addressKey(wallet);
  };

  for (const { record, proofs } of transcript.rounds) {
    const proofOf = new Map(proofs.map((proof) => [proof.index, proof]));
    for (const move of record.moves) {
      const seat = move.index;
      const place = { matchId, round: record.round, seat };
      if (move.revealed && commitMove(matchId, record.round, seat, move).toLowerCase() !== move.commitment.toLowerCase()) {
        problems.push(`round ${record.round}: seat ${seat}'s reveal does not open its commitment`);
      }
      if (bots.has(seat)) continue;
      const proof = proofOf.get(seat);
      if (move.commitment !== NO_COMMITMENT) {
        const signature = proof?.commitSignature;
        if (!signature || !(await signedBySeat(seat, commitTypedData(chainId, place, move.commitment), signature))) {
          problems.push(`round ${record.round}: seat ${seat}'s commitment is not signed by its player`);
        }
      }
      if (move.revealed) {
        const signature = proof?.revealSignature;
        if (!signature || !(await signedBySeat(seat, revealTypedData(chainId, place, move), signature))) {
          problems.push(`round ${record.round}: seat ${seat}'s reveal is not signed by its player`);
        }
      }
    }
  }
  return problems;
}

/** The auditor's own seat, against what this browser sealed and sent. */
function checkOwnMoves(transcript: Transcript, own: NonNullable<AuditOptions['own']>): string[] {
  const problems: string[] = [];
  const records = new Map(transcript.rounds.map(({ record }) => [record.round, record]));
  for (const [round, sealed] of own.moves) {
    const record = records.get(round);
    const mine = commitMove(transcript.matchId, round, own.seat, sealed);
    const entry = record?.moves.find((move) => move.index === own.seat);
    if (!entry || entry.commitment.toLowerCase() !== mine.toLowerCase()) {
      // Without a receipt the commit may simply never have arrived.
      if (sealed.receipt) problems.push(`round ${round}: the server receipted your commitment, and the transcript leaves it out`);
      continue;
    }
    if (sealed.revealed && !entry.revealed) {
      problems.push(`round ${round}: you revealed, and the transcript counts you as not revealing`);
    } else if (entry.revealed && !sameMove(entry, sealed)) {
      problems.push(`round ${round}: the transcript shows a different move from the one you sealed`);
    }
  }
  return problems;
}

function sameMove(
  published: { action: ActionValue; target: number; salt: `0x${string}` },
  sealed: { action: ActionValue; target: number; salt: `0x${string}` },
): boolean {
  const target = sealed.action === Action.Strike ? sealed.target : 0;
  return (
    published.action === sealed.action &&
    published.target === target &&
    published.salt.toLowerCase() === sealed.salt.toLowerCase()
  );
}
