import type { Address, Hex } from 'viem';
import {
  MATCH_ABORT_TYPES,
  MATCH_RESULT_TYPES,
  gameEscrowAbi,
  hashTranscript,
  matchResultDomain,
  matchResultMessage,
  receiptTypedData,
  type CommitReceipt,
  type Transcript,
} from '@lms/protocol';
import { auditTranscript, rankingHash } from '@lms/engine';
import type { Signer } from '../chain/signer.js';
import { readClient } from '../chain/viem.js';

/**
 * What the server asks of an attestor. The server never signs a result
 * itself: it hands the attestor the whole transcript, and gets a signature
 * back only for a result the transcript replays to.
 */
export interface Attestor {
  readonly address: Address;
  /** Signs the transcript's `MatchResult`, or throws `AttestationRefused`. */
  attest(transcript: Transcript): Promise<Hex>;
  /** Signs a `MatchAbort`, which can only refund every seat. */
  abort(matchId: `0x${string}`): Promise<Hex>;
  /** Signs a commit receipt, so the escrow's attestor set vouches for it. */
  receipt(receipt: CommitReceipt): Promise<Hex>;
}

/** The transcript does not hold up; nothing was signed. `message` lists why. */
export class AttestationRefused extends Error {
  override name = 'AttestationRefused';
  readonly code = 'ATTESTATION_REFUSED';
}

/** What the escrow stored for a match before it was played. */
export interface StakedMatch {
  seed: `0x${string}`;
  rulesHash: `0x${string}`;
  seats: readonly `0x${string}`[];
}

export interface AttestorServiceOptions {
  signer: Signer;
  chainId: number;
  escrow: Address;
  /**
   * Reads a match's seed, rules and seats from the escrow. With it, a
   * transcript naming any other seed, rules or seats is refused; without it
   * (practice-only, tests) the transcript is checked against itself alone.
   */
  chain?: (matchId: `0x${string}`) => Promise<StakedMatch>;
}

/**
 * The attestor: replays a transcript through the engine, as anyone auditing
 * it later would, and signs only a result that replay produces.
 *
 * It checks every round hash, the root, the ranking, every reveal against
 * its commitment, and every commit and reveal against a key its seat's
 * wallet granted; with `chain`, also the seed, the rules and the seats
 * against the escrow. So a bug or a compromise in the game server cannot get
 * a result signed that its own transcript does not support.
 */
export class AttestorService implements Attestor {
  constructor(private readonly options: AttestorServiceOptions) {}

  get address(): Address {
    return this.options.signer.address;
  }

  async attest(transcript: Transcript): Promise<Hex> {
    const { chainId, escrow, chain, signer } = this.options;
    if (transcript.chainId !== chainId) {
      throw new AttestationRefused(`the transcript is for chain ${transcript.chainId}, not ${chainId}`);
    }
    const transcriptHash = hashTranscript(transcript);
    const { result } = transcript;
    const staked = chain ? await chain(transcript.matchId) : null;
    const audit = await auditTranscript(
      transcript,
      staked
        ? {
            // Nothing is proposed yet, so the result's own fields stand in for
            // what `settle` will store; the rest is what the escrow holds now.
            chain: {
              ...staked,
              rounds: result.rounds,
              historyRoot: result.historyRoot,
              rankingHash: rankingHash(result.ranking),
              transcriptHash,
            },
          }
        : {},
    );
    if (!audit.ok) throw new AttestationRefused(`${transcript.matchId}: ${audit.problems.join('; ')}`);
    return signer.signTypedData({
      domain: matchResultDomain(chainId, escrow),
      types: MATCH_RESULT_TYPES,
      primaryType: 'MatchResult',
      message: matchResultMessage({ ...result, transcriptHash }),
    });
  }

  abort(matchId: `0x${string}`): Promise<Hex> {
    return this.options.signer.signTypedData({
      domain: matchResultDomain(this.options.chainId, this.options.escrow),
      types: MATCH_ABORT_TYPES,
      primaryType: 'MatchAbort',
      message: { matchId },
    });
  }

  receipt(receipt: CommitReceipt): Promise<Hex> {
    return this.options.signer.signTypedData(receiptTypedData(this.options.chainId, receipt));
  }
}

/** Reads `StakedMatch` from the escrow over viem. */
export function escrowMatchReader(options: {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
}): (matchId: `0x${string}`) => Promise<StakedMatch> {
  const client = readClient(options.chainId, options.rpcUrl);
  const { escrow } = options;
  return async (matchId) => {
    const [info, terms, seats] = await Promise.all([
      client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getMatch', args: [matchId] }),
      client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getMatchTerms', args: [matchId] }),
      client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getSeats', args: [matchId] }),
    ]);
    return { seed: info.seed, rulesHash: terms.rulesHash, seats };
  };
}
