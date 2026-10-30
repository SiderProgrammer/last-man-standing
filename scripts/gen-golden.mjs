#!/usr/bin/env node
/**
 * Writes the frozen golden transcripts in `contracts/test/fixtures/golden/`.
 *
 *   npm run build && node scripts/gen-golden.mjs
 *
 * Each is a whole match played by seeded bots with signed moves, under fixed
 * keys, salts and receive times, so the same code always writes the same
 * bytes. They are frozen on purpose: `packages/engine/test/golden.test.ts`
 * replays every one through `Match` and through `replayMatch`, and
 * `contracts/test/unit/GoldenTranscript.t.sol` rebuilds every round hash and
 * the history root in Solidity. A change to the rules, the kernel, a hash or
 * the transcript format then fails those tests rather than drifting by.
 * Regenerate only for a change that is meant to break consensus, and say so.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Action,
  DEFAULT_RULES,
  NO_COMMITMENT,
  TRANSCRIPT_VERSION,
  ZERO_SALT,
  commitMove,
  commitTypedData,
  grantTypedData,
  hashRules,
  hashTranscript,
  historySeed,
  revealTypedData,
} from '@lms/protocol';
import { Match, Prng, readerStrategy, smartStrategy } from '@lms/engine';

const CHAIN_ID = 84532;
const OUT = new URL('../contracts/test/fixtures/golden/', import.meta.url);

const label = (text) => keccak256(stringToHex(text));

/**
 * @param name   file name, and the label every key and salt is derived from
 * @param seats  number of players
 * @param silent seat -> first round from which it stops revealing
 * @param absent seat -> the one round it does not commit at all
 */
async function golden(name, seats, { silent = {}, absent = {} } = {}) {
  const wallets = Array.from({ length: seats }, (_, i) => privateKeyToAccount(label(`${name}:wallet:${i}`)));
  const keys = Array.from({ length: seats }, (_, i) => privateKeyToAccount(label(`${name}:key:${i}`)));
  const seatList = wallets.map((wallet, index) => ({ index, address: wallet.address, chainId: CHAIN_ID }));
  const match = new Match({ matchId: label(`${name}:match`), seats: seatList, seed: label(`${name}:seed`), rules: DEFAULT_RULES });
  const strategies = seatList.map((seat) =>
    seat.index % 2 === 0
      ? readerStrategy(new Prng(label(`${name}:bot:${seat.index}`)))
      : smartStrategy(new Prng(label(`${name}:bot:${seat.index}`)), 'hard'),
  );

  const grants = [];
  for (let i = 0; i < seats; i += 1) {
    const grant = {
      wallet: wallets[i].address,
      sessionKey: keys[i].address,
      domain: 'play.lastmanstanding.test',
      uri: 'https://play.lastmanstanding.test',
      chainId: CHAIN_ID,
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_086_400,
      nonce: label(`${name}:nonce:${i}`),
    };
    grants.push({ grant, signature: await wallets[i].signTypedData(grantTypedData(grant)) });
  }

  const rounds = [];
  while (!match.finished) {
    const round = match.round;
    const proofs = new Map();
    const sealed = new Map();
    for (const seat of match.alive) {
      if (absent[seat] === round) continue;
      const move = { ...strategies[seat](seat, match), salt: label(`${name}:salt:${round}:${seat}`) };
      sealed.set(seat, move);
      const place = { matchId: match.matchId, round, seat };
      const commitment = commitMove(match.matchId, round, seat, move);
      match.submitCommit(seat, commitment);
      proofs.set(seat, {
        index: seat,
        commitSignature: await keys[seat].signTypedData(commitTypedData(CHAIN_ID, place, commitment)),
        revealSignature: null,
        receivedAt: 1_800_000_000_000 + round * 10_000 + seat,
      });
    }
    match.openRevealPhase();
    for (const [seat, move] of sealed) {
      if (silent[seat] !== undefined && round >= silent[seat]) continue;
      match.submitReveal(seat, move);
      const place = { matchId: match.matchId, round, seat };
      proofs.get(seat).revealSignature = await keys[seat].signTypedData(revealTypedData(CHAIN_ID, place, move));
    }
    const record = match.resolve();
    rounds.push({
      record,
      proofs: record.moves.map(
        (move) => proofs.get(move.index) ?? { index: move.index, commitSignature: null, revealSignature: null, receivedAt: null },
      ),
    });
  }

  const transcript = {
    version: TRANSCRIPT_VERSION,
    matchId: match.matchId,
    chainId: CHAIN_ID,
    seed: match.seed,
    rules: match.rules,
    seats: seatList,
    botSeats: [],
    receiptSigner: privateKeyToAccount(label(`${name}:receipts`)).address,
    grants,
    rounds,
    result: match.result(),
  };

  // The same rounds flattened into seat-indexed arrays, which is all the
  // Solidity test can read: `vm.parseJson*` takes arrays, not records.
  const chain = {
    rulesHash: hashRules(match.rules),
    historySeed: historySeed(match.matchId, hashRules(match.rules), match.seed),
    roundCount: rounds.length,
    rounds: rounds.map(({ record }) => {
      const bySeat = (pick, fill) => {
        const out = new Array(seats).fill(fill);
        for (const move of record.moves) out[move.index] = pick(move);
        return out;
      };
      return {
        round: record.round,
        actions: bySeat((move) => move.action, Action.None),
        targets: bySeat((move) => (move.action === Action.Strike ? move.target : 0), 0),
        salts: bySeat((move) => (move.revealed ? move.salt : ZERO_SALT), ZERO_SALT),
        commitments: bySeat((move) => move.commitment, NO_COMMITMENT),
        hpAfter: record.hpAfter.map((hp) => Math.max(0, hp)),
        eliminated: record.eliminated,
        hash: record.hash,
      };
    }),
  };

  mkdirSync(OUT, { recursive: true });
  const file = new URL(`${name}.json`, OUT);
  writeFileSync(file, `${JSON.stringify({ transcriptHash: hashTranscript(transcript), transcript, chain }, null, 2)}\n`);
  console.log(`${name}: ${rounds.length} rounds, root ${transcript.result.historyRoot}`);
}

await golden('four-seats', 4, { silent: { 3: 2 } });
await golden('eight-seats', 8, { silent: { 5: 4 }, absent: { 2: 1 } });
