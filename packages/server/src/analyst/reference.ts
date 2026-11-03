import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import {
  DEFAULT_RULES,
  TRANSCRIPT_VERSION,
  hashTranscript,
  type Rules,
  type Seat,
  type Transcript,
} from '@lms/consensus';
import { Match } from '@lms/engine';
import { Prng, playRound } from '@lms/engine/bots';
import { strategyByName, type StrategyName } from '@lms/engine/sim';
import type { ArchivedMatch } from '../lobby/store.js';

/**
 * Reference matches: real games, played by the engine's seeded bots, whose
 * every fact is known in advance because the same label always plays the
 * same match.
 *
 * Unit tests use them as realistic fixtures for the analyst and the claim
 * verifier — no hand-written history that the engine could never have
 * produced.
 */
export interface ReferenceMatch extends ArchivedMatch {
  /** The strategy each seat played, by seat index. */
  strategies: StrategyName[];
}

const LABEL_ABI = parseAbiParameters('string label');
const label = (text: string): `0x${string}` => keccak256(encodeAbiParameters(LABEL_ABI, [text]));

export function playReferenceMatch(options: {
  label: string;
  strategies: readonly StrategyName[];
  rules?: Rules;
}): ReferenceMatch {
  const rules = options.rules ?? DEFAULT_RULES;
  const base = `analyst-ref:${options.label}`;
  const seats: Seat[] = options.strategies.map((_, index) => ({
    index,
    address: `0x${label(`${base}:seat:${index}`).slice(2, 42)}` as `0x${string}`,
    chainId: 0,
  }));
  const seed = label(`${base}:seed`);
  const match = new Match({ matchId: label(`${base}:id`), seats, seed, rules });
  const players = options.strategies.map((name, seat) => strategyByName(name, new Prng(label(`${base}:${seat}`))));

  while (!match.finished) {
    const round = match.round;
    playRound(match, players, (seat) => label(`${base}:salt:${round}:${seat}`));
  }

  // Every seat is a bot, so nothing in it is signed.
  const transcript: Transcript = {
    version: TRANSCRIPT_VERSION,
    matchId: match.matchId,
    chainId: 0,
    seed,
    rules,
    seats,
    botSeats: seats.map((seat) => seat.index),
    receiptSigner: null,
    grants: [],
    rounds: match.history.map((record) => ({
      record,
      proofs: record.moves.map((move) => ({
        index: move.index,
        commitSignature: null,
        revealSignature: null,
        receivedAt: null,
      })),
    })),
    result: match.result(),
  };

  return {
    result: match.result(),
    history: [...match.history],
    transcript,
    transcriptHash: hashTranscript(transcript),
    settledTx: null,
    seats,
    rules,
    // A reference match is replayed for the analyst, never shown as anyone's.
    staked: false,
    seed,
    finishedAt: 0,
    strategies: [...options.strategies],
  };
}
