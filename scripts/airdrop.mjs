#!/usr/bin/env node
/**
 * `npm run airdrop` — computes the LMS airdrop from the escrow's history.
 *
 * Every settled match charged each seat `stake × feeBps`. This sums that per
 * player, splits `AIRDROP_TOTAL` LMS in proportion — capped so that nobody
 * receives more than `AIRDROP_CAP_BPS` of the fees they paid, valued at
 * `AIRDROP_LMS_PER_ETH` — builds the Merkle tree
 * `LmsAirdrop` checks, and writes every claim with its proof to a JSON file —
 * the file the claim page, or anyone claiming by hand, reads proofs from.
 *
 * Read-only: it sends no transaction. Afterwards:
 *
 *   1. deploy the contract with the printed root:
 *        AIRDROP_ROOT=0x… LMS=0x… STAKED_LMS=0x… AIRDROP_TREASURY=<safe> \
 *          forge script script/Airdrop.s.sol --root contracts --rpc-url $RPC_URL --broadcast
 *   2. have the Safe transfer the printed total of LMS to it,
 *   3. publish the JSON.
 *
 * Needs the TypeScript packages built first (`npm run build`).
 *
 * Environment:
 *   RPC_URL          hub chain RPC                          required
 *   ESCROW_ADDRESS   GameEscrow                             required
 *   AIRDROP_TOTAL    LMS to distribute, in whole tokens     required
 *   FROM_BLOCK       first block to scan                    default 0
 *   TO_BLOCK         last block to scan                     default latest
 *   AIRDROP_LMS_PER_ETH  reference price for the cap, e.g. the pool's starting price   required
 *   AIRDROP_CAP_BPS  most anyone receives, as a share of the
 *                    value of the fees they paid            default 2500 (tolerates a 4× price rise)
 *   AIRDROP_MIN_OPPONENTS  distinct opponents an address must
 *                    have played to qualify                 default 3
 *   EXCLUDE          comma-separated addresses to leave out (team wallets, house bots)
 *   OUT              output file                            default airdrop.json
 *
 * Why the cap: a farmer filling a lobby with their own wallets gets every stake
 * back, so the fee is their whole cost. Below 100% of it at the reference price,
 * farming loses money. Whatever the cap cuts is left undistributed rather than
 * handed to everyone else — that would reward whoever farmed hardest.
 *
 * Why opponents: wallets that only ever play each other are what self-play
 * looks like. Requiring several distinct opponents means the stake was put
 * against people who could win it.
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, getAddress, http, parseEther } from 'viem';
import { allocate, buildAirdrop, eligibleFees, feeCap, gameEscrowAbi, MatchStatus, playerHistory } from '@lms/protocol';

/** Many public RPCs cap `eth_getLogs` at 10k blocks. */
const LOG_CHUNK = 10_000n;
/** Reads in flight at once. */
const CONCURRENCY = 16;

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required. See the header of scripts/airdrop.mjs.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const client = createPublicClient({ transport: http(required('RPC_URL')) });
  const escrow = getAddress(required('ESCROW_ADDRESS'));
  const total = parseEther(required('AIRDROP_TOTAL'));
  const exclude = (process.env.EXCLUDE ?? '').split(',').filter(Boolean).map((a) => getAddress(a.trim()));
  const out = process.env.OUT || 'airdrop.json';
  const lmsPerEth = BigInt(required('AIRDROP_LMS_PER_ETH'));
  const capBps = Number(process.env.AIRDROP_CAP_BPS || 2_500);
  const minOpponents = Number(process.env.AIRDROP_MIN_OPPONENTS || 3);

  const from = BigInt(process.env.FROM_BLOCK || 0);
  const to = process.env.TO_BLOCK ? BigInt(process.env.TO_BLOCK) : await client.getBlockNumber();

  const matchIds = [];
  for (let start = from; start <= to; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n < to ? start + LOG_CHUNK - 1n : to;
    const logs = await client.getContractEvents({
      address: escrow,
      abi: gameEscrowAbi,
      eventName: 'MatchSettled',
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) if (log.args.matchId) matchIds.push(log.args.matchId);
  }
  console.log(`[airdrop] ${matchIds.length} settled matches in blocks ${from}–${to}`);

  const matches = [];
  for (let i = 0; i < matchIds.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      matchIds.slice(i, i + CONCURRENCY).map(async (matchId) => {
        const [info, seats] = await Promise.all([
          client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getMatch', args: [matchId] }),
          client.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getSeats', args: [matchId] }),
        ]);
        return info.status === MatchStatus.Settled ? { stake: info.stake, feeBps: info.feeBps, seats } : null;
      }),
    );
    for (const match of batch) if (match) matches.push(match);
  }

  const history = playerHistory(matches);
  const weights = eligibleFees(history, minOpponents);
  console.log(`[airdrop] ${weights.size} of ${history.size} players met at least ${minOpponents} distinct opponents`);

  const allocations = allocate(weights, total, { exclude, capPerWeight: feeCap(lmsPerEth, capBps) });
  if (allocations.size === 0) {
    console.error('[airdrop] nobody qualifies in that range; nothing to distribute.');
    process.exit(1);
  }
  const airdrop = buildAirdrop(allocations);

  writeFileSync(
    out,
    `${JSON.stringify(
      { escrow, fromBlock: from, toBlock: to, lmsPerEth, capBps, minOpponents, ...airdrop },
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    )}\n`,
  );

  console.log(`[airdrop] ${allocations.size} claimants, ${airdrop.total} wei of LMS`);
  console.log(`[airdrop] ${total - airdrop.total} wei left undistributed by the cap and rounding: it stays with the Safe`);
  console.log(`[airdrop] root ${airdrop.root}`);
  console.log(`[airdrop] wrote ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
