#!/usr/bin/env node
/**
 * Fails when a contract that moves value has under 90% branch coverage.
 *
 *   node scripts/coverage-gate.mjs contracts/lcov.info
 *
 * The argument is the lcov report `forge coverage --report lcov` writes. Each
 * file below must have at least `MIN_BRANCH_PCT` of its branches taken; any
 * other file is reported but not gated. A file listed here and missing from
 * the report fails too, so a rename cannot drop a contract from the gate.
 */
import { readFileSync } from 'node:fs';

const MIN_BRANCH_PCT = 90;

/** Contracts that hold, move or decide where ETH or LMS goes. */
const GATED = [
  'src/GameEscrow.sol',
  'src/PullPayable.sol',
  'src/ExpiringPause.sol',
  'src/ProtocolConfig.sol',
  'src/SessionKeyDelegate.sol',
  'src/oracles/ChainlinkVrfAdapter.sol',
  'src/periphery/BridgeJoinReceiver.sol',
  'src/periphery/SpokeRouter.sol',
  'src/periphery/ZapJoin.sol',
  'src/governance/FeeRouter.sol',
  'src/governance/LiquidityReserve.sol',
  'src/governance/LmsGovernor.sol',
  'src/governance/MultisigPhase.sol',
  'src/governance/RewardVesting.sol',
  'src/governance/RewardsDistributor.sol',
  'src/governance/StakedLms.sol',
];

const [reportPath] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: coverage-gate.mjs <lcov.info>');
  process.exit(2);
}

/** File → { found, hit } branch counts, from each record's BRF and BRH lines. */
const files = new Map();
let current;
for (const line of readFileSync(reportPath, 'utf8').split(/\r?\n/)) {
  if (line.startsWith('SF:')) {
    current = { found: 0, hit: 0 };
    files.set(line.slice(3).replaceAll('\\', '/'), current);
  } else if (line.startsWith('BRF:')) {
    current.found = Number(line.slice(4));
  } else if (line.startsWith('BRH:')) {
    current.hit = Number(line.slice(4));
  }
}

const pct = ({ found, hit }) => (found === 0 ? 100 : (100 * hit) / found);
const failures = [];
for (const path of GATED) {
  const counts = [...files].find(([file]) => file.endsWith(path))?.[1];
  if (!counts) {
    failures.push(`${path}: not in the report`);
    continue;
  }
  const line = `${path}: ${pct(counts).toFixed(2)}% (${counts.hit}/${counts.found})`;
  if (pct(counts) < MIN_BRANCH_PCT) failures.push(line);
  else console.log(line);
}

for (const failure of failures) console.error(`below ${MIN_BRANCH_PCT}%: ${failure}`);
if (failures.length > 0) process.exit(1);
console.log(`Branch coverage is at least ${MIN_BRANCH_PCT}% on all ${GATED.length} gated contracts.`);
