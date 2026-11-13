#!/usr/bin/env node
/**
 * `npm run fork:base` — a rehearsal of the Base mainnet deploy on local forks,
 * with the whole stack running against it, ready for 4, 6 or 8 players.
 *
 * Unlike `npm run dev:fork`, which forks Ethereum as chain 31337 and runs the
 * deploy's local path (mock oracle, mock Across pools), this forks the real
 * chains and keeps their chain ids, so `Deploy.s.sol` takes its production
 * path: Chainlink VRF v2.5 on Base, Across's real SpokePools, Uniswap v4,
 * Chainlink's sequencer uptime feed, separate Safe / guardian / attestor /
 * matchmaker / team roles, the production timelock and governance settings.
 *
 *   1. builds the TypeScript packages,
 *   2. forks Base (8453, the hub) and three spokes: Arbitrum One (42161),
 *      OP Mainnet (10) and Ethereum (1) — `FORK_SPOKES=arb,op` runs fewer,
 *   3. as the Safe, creates a VRF subscription on Chainlink's real Base
 *      coordinator and funds it with ETH,
 *   4. deploys the hub with `Deploy.s.sol` and each spoke with
 *      `DeploySpoke.s.sol`, then, as the Safe, adds the VRF adapter as a
 *      consumer — the same steps as docs/TESTNET.md on mainnet,
 *   5. plays the VRF node: each randomness request is answered three blocks
 *      later, delivered as the real coordinator does (from its address),
 *   6. plays an Across relayer between the hub and each spoke: every deposit
 *      `SpokeRouter` or `BridgeJoinReceiver` makes into a real SpokePool is
 *      filled on the other chain's real SpokePool,
 *   7. funds 8 player accounts with ETH on every chain, every token that has
 *      a live Uniswap v4 route to ETH on Base, liquid LMS, and staked sLMS
 *      (from the treasury, impersonating the timelock),
 *   8. starts the server and the client wired to all of it, and writes
 *      `contracts/deployments/fork/profile.json` for `npm run play`.
 *
 * Blocks are mined like the real chains: every 2 s on Base and OP, every
 * second on Arbitrum, every 12 s on Ethereum. Time can be moved with
 * `npm run play -- warp 1h`.
 *
 * The registries the deploy scripts write land in
 * `contracts/deployments/fork/` (gitignored); whatever was in
 * `contracts/deployments/<chainId>.json` before is put back, so the real
 * chains' committed registries are never touched.
 *
 * Environment (all optional):
 *   FORK_BASE_RPC_URL   Base RPC to fork, with archive state
 *   FORK_ARB_RPC_URL    Arbitrum RPC to fork, with archive state
 *   FORK_OP_RPC_URL     OP Mainnet RPC to fork, with archive state
 *   FORK_ETH_RPC_URL    Ethereum RPC to fork, with archive state
 *   ALCHEMY_API_KEY     used for every chain whose URL is unset; without it,
 *                       the key of any Alchemy URL in `.env` (the Alchemy app
 *                       must have each network enabled); without that,
 *                       publicnode, which only lasts a few minutes
 *   FORK_SPOKES         which spokes to run, default arb,op,eth; the first is
 *                       the one `&chain=spoke` and `--from spoke` mean
 *   FORK_HUB_PORT       default 8645
 *   FORK_SPOKE_PORT     Arbitrum, default 8646
 *   FORK_OP_PORT        default 8647
 *   FORK_ETH_PORT       default 8648
 *   FORK_SERVER_PORT    default 8791
 *   FORK_CLIENT_PORT    default 5176
 *   FORK_FILL_DELAY_MS  how long an Across deposit waits for its fill, default 5000
 *   FORK_CUPS           compute units per second each fork may use on its RPC;
 *                       default 330 shared across the forks (Alchemy's free tier)
 *   FORK_MAINNET_ECONOMICS=1  keep Base's defaults: no stakers' share of fees and
 *                       no LMS fee discount. Unset, both are switched on (as the
 *                       timelock) so those features can be tried.
 *   COMMIT_MS / REVEAL_MS  phase timers for the server, default 60000 / 15000:
 *                       long enough to play eight tabs by hand.
 *   GEMINI_*, ANALYST_*  the match analyst's settings, from the shell or `.env`:
 *                       the only part of `.env` the fork's server is given.
 *   FORK_DATABASE_URL   Postgres for the fork's server, so a restart resumes live
 *                       matches from their journal. Its own database: the server
 *                       locks it, so never the one a hosted server uses. Unset,
 *                       everything is in memory and a restart refunds live matches.
 *
 * Ctrl+C stops everything.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseAbiItem,
  parseEther,
  parseEventLogs,
  parseUnits,
  toHex,
  zeroAddress,
} from 'viem';

import { artifactPath } from './artifacts.mjs';
import { FORK_ACCOUNT_COUNT, forkAccount, forkPlayers, forkRoles } from './lib/forkAccounts.mjs';
import { readDotEnv } from './lib/profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = fileURLToPath(new URL('../contracts/', import.meta.url));
const DEPLOYMENTS = fileURLToPath(new URL('../contracts/deployments/', import.meta.url));
const FORK_DIR = fileURLToPath(new URL('../contracts/deployments/fork/', import.meta.url));

/**
 * A fork reads state at its fork block for as long as it runs, so the RPC has
 * to serve historical state: public endpoints serve only the last few minutes
 * of it, after which the fork fails mid-session. An Alchemy key, from
 * `ALCHEMY_API_KEY` or any Alchemy URL already in `.env`, serves both chains.
 */
const ALCHEMY_KEY = alchemyKey();
const HUB_FORK_URL =
  process.env.FORK_BASE_RPC_URL || (ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : 'https://base-rpc.publicnode.com');

function alchemyKey() {
  if (process.env.ALCHEMY_API_KEY) return process.env.ALCHEMY_API_KEY;
  const env = readDotEnv();
  for (const value of Object.values(env)) {
    const match = /alchemy\.com\/v2\/([A-Za-z0-9_-]+)/.exec(value);
    if (match) return match[1];
  }
  return null;
}

/**
 * A transport to one of our anvils. A fork answers a call only once it has
 * fetched the state the call touches from the remote RPC, which under a rate
 * limit can take far longer than viem's default 10 s.
 */
const local = (url) => http(url, { timeout: 120_000 });

/**
 * Compute units per second each anvil may spend on the remote RPC. Every fork
 * on one Alchemy key shares that key's limit, so together they stay under it
 * instead of each assuming the whole of it and all being throttled at once.
 * `FORK_CUPS` overrides it.
 */
const forkCups = (forks) => Number(process.env.FORK_CUPS || Math.max(50, Math.floor(330 / forks)));

/** An RPC URL fit for a log line: no API key in it. */
const masked = (url) => url.replace(/\/v2\/[A-Za-z0-9_-]+/, '/v2/***').replace(/([?&](?:key|apikey|token)=)[^&]+/i, '$1***');

const HUB_PORT = Number(process.env.FORK_HUB_PORT || 8645);
const SERVER_PORT = Number(process.env.FORK_SERVER_PORT || 8791);
const CLIENT_PORT = Number(process.env.FORK_CLIENT_PORT || 5176);
const FILL_DELAY_MS = Number(process.env.FORK_FILL_DELAY_MS || 5_000);
const MAINNET_ECONOMICS = process.env.FORK_MAINNET_ECONOMICS === '1';

const HUB_CHAIN_ID = 8453;
const HUB_RPC = `http://127.0.0.1:${HUB_PORT}`;
const WS_URL = `ws://localhost:${SERVER_PORT}`;

// Chainlink VRF v2.5 on Base: the same coordinator `Deploy.s.sol` defaults to.
const VRF_COORDINATOR = '0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634';
const VRF_CONFIRMATIONS = 3n;
/** Fills of one deposit the fork's Across relayer tries before giving up on it. */
const FILL_ATTEMPTS = 3;
// Uniswap v4 on Base.
const POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
const V4_QUOTER = '0x0d5e0f971ed27fbff6c2837bf31316121532048d';
// Across, from config/across.json.
const ACROSS = JSON.parse(readFileSync(new URL('../contracts/config/across.json', import.meta.url), 'utf8')).chains;
const HUB_POOL = ACROSS[HUB_CHAIN_ID].spokePool;
const HUB_WETH = ACROSS[HUB_CHAIN_ID].weth;

/**
 * The spokes a player can stake from, each an anvil fork of the real chain
 * with its real Across SpokePool. The first one run is what `&chain=spoke`
 * and `npm run play -- --from spoke` mean; the alias is what `&chain=` and
 * `--from` take.
 */
const SPOKE_CHAINS = [
  { alias: 'arb', chainId: 42161, name: 'Arbitrum', urlEnv: 'FORK_ARB_RPC_URL', alchemy: 'arb-mainnet', publicRpc: 'https://arbitrum-one-rpc.publicnode.com', portEnv: 'FORK_SPOKE_PORT', port: 8646, blockSeconds: 1 },
  { alias: 'op', chainId: 10, name: 'Optimism', urlEnv: 'FORK_OP_RPC_URL', alchemy: 'opt-mainnet', publicRpc: 'https://optimism-rpc.publicnode.com', portEnv: 'FORK_OP_PORT', port: 8647, blockSeconds: 2 },
  { alias: 'eth', chainId: 1, name: 'Ethereum', urlEnv: 'FORK_ETH_RPC_URL', alchemy: 'eth-mainnet', publicRpc: 'https://ethereum-rpc.publicnode.com', portEnv: 'FORK_ETH_PORT', port: 8648, blockSeconds: 12 },
];
const SPOKES = pickSpokes(process.env.FORK_SPOKES).map((chain) => {
  const port = Number(process.env[chain.portEnv] || chain.port);
  const rpc = `http://127.0.0.1:${port}`;
  return {
    ...chain,
    port,
    rpc,
    forkUrl: process.env[chain.urlEnv] || (ALCHEMY_KEY ? `https://${chain.alchemy}.g.alchemy.com/v2/${ALCHEMY_KEY}` : chain.publicRpc),
    client: createPublicClient({ transport: local(rpc) }),
    pool: ACROSS[chain.chainId].spokePool,
    weth: ACROSS[chain.chainId].weth,
  };
});

/** `FORK_SPOKES=arb,op`: those spokes, in that order. Unset: all of them. */
function pickSpokes(spec) {
  if (!spec) return SPOKE_CHAINS;
  const picked = spec.split(',').map((alias) => alias.trim().toLowerCase()).filter(Boolean).map((alias) => {
    const chain = SPOKE_CHAINS.find((c) => c.alias === alias);
    if (!chain) {
      console.error(`FORK_SPOKES: no spoke "${alias}". Known: ${SPOKE_CHAINS.map((c) => c.alias).join(', ')}.`);
      process.exit(1);
    }
    return chain;
  });
  if (picked.length === 0) {
    console.error('FORK_SPOKES names no spoke: leave it unset for all of them.');
    process.exit(1);
  }
  return picked;
}

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * Tokens offered for paying a stake, each with the routes to ETH to try in
 * order. Only routes the real v4 quoter can price at the fork block are kept,
 * since liquidity moves; a token with none is left out, and said so.
 */
const TOKEN_CANDIDATES = [
  { symbol: 'USDC', address: USDC, decimals: 6, funding: '10000', paths: [[[USDC, 500, 10]], [[USDC, 3000, 60]], [[USDC, 100, 1]]] },
  {
    symbol: 'USDT',
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    decimals: 6,
    funding: '10000',
    paths: [
      [['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 500, 10]],
      [['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 3000, 60]],
      [['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 100, 1]],
      [['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 100, 1], [USDC, 500, 10]],
    ],
  },
  {
    symbol: 'DAI',
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    decimals: 18,
    funding: '10000',
    paths: [
      [['0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 500, 10]],
      [['0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 3000, 60]],
      [['0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 100, 1], [USDC, 500, 10]],
    ],
  },
  {
    symbol: 'cbBTC',
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    decimals: 8,
    funding: '0.5',
    paths: [[['0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 500, 10]], [['0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 3000, 60]]],
  },
];

/** Each player's sLMS, from the treasury: clears the 100k proposal threshold, and four of them the 1M quorum floor. */
const PLAYER_STAKED_LMS = '300000';
/** Each player's liquid LMS, for paying part of a fee in LMS. */
const PLAYER_LIQUID_LMS = '50000';
/** What `FORK_MAINNET_ECONOMICS` leaves off on Base: half the fees to stakers, and 20k LMS buys 1 ETH of fee. */
const DEMO_STAKER_BPS = 5_000;
const DEMO_LMS_PER_ETH = parseEther('20000');

const MATCHMAKING_TIERS = [
  { stake: parseEther('0.001').toString(), seats: 4 },
  { stake: parseEther('0.001').toString(), seats: 6 },
  { stake: parseEther('0.001').toString(), seats: 8 },
  { stake: parseEther('0.01').toString(), seats: 4 },
];

const roles = forkRoles();
const players = forkPlayers();

const hub = createPublicClient({ transport: local(HUB_RPC) });

/** A wallet client for an account anvil signs for (every mnemonic account, and anything impersonated). */
const signerOn = (rpc, address) => createWalletClient({ account: address, transport: local(rpc) });

const abiOf = (contract) => JSON.parse(readFileSync(artifactPath(`${CONTRACTS}out/`, contract), 'utf8')).abi;

const coordinatorAbi = parseAbi([
  'function createSubscription() returns (uint256 subId)',
  'function fundSubscriptionWithNative(uint256 subId) payable',
  'function addConsumer(uint256 subId, address consumer)',
  'function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)',
  'event SubscriptionCreated(uint256 indexed subId, address owner)',
]);
const adapterAbi = parseAbi([
  'event RandomnessRequested(uint256 indexed vrfId, address indexed consumer, bytes32 context)',
  'function rawFulfillRandomWords(uint256 vrfId, uint256[] randomWords)',
]);
const quoterAbi = parseAbi([
  'struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }',
  'struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }',
  'function quoteExactOutput(QuoteExactParams params) returns (uint256 amountIn, uint256 gasEstimate)',
]);
const wethAbi = parseAbi(['function deposit() payable', 'function approve(address, uint256) returns (bool)']);
/** Across v3.5+ (the version `config/across.json` names): deposits and fills use bytes32 addresses. */
const fundsDeposited = parseAbiItem(
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
);
const fillAbi = parseAbi([
  'struct V3RelayData { bytes32 depositor; bytes32 recipient; bytes32 exclusiveRelayer; bytes32 inputToken; bytes32 outputToken; uint256 inputAmount; uint256 outputAmount; uint256 originChainId; uint256 depositId; uint32 fillDeadline; uint32 exclusivityDeadline; bytes message; }',
  'function fillRelay(V3RelayData relayData, uint256 repaymentChainId, bytes32 repaymentAddress)',
]);

const children = [];
let stopping = false;

// ------------------------------------------------------------------ output

const COLORS = { hub: 90, arb: 90, op: 90, eth: 90, server: 36, client: 35, fork: 32, vrf: 33, across: 34 };

function log(tag, line) {
  process.stdout.write(`\x1b[${COLORS[tag] ?? 0}m[${tag}]\x1b[0m ${line}\n`);
}

function fail(message) {
  log('fork', `\x1b[31m${message}\x1b[0m`);
  shutdown(1);
}

const reason = (error) => error?.shortMessage ?? error?.message ?? String(error);
const NO_FOUNDRY = 'was not found. Install Foundry (https://getfoundry.sh) and make sure it is on PATH.';

// --------------------------------------------------------------- processes

function start(tag, command, args, { tagged = true, ...options } = {}) {
  const child = spawn(command, args, { cwd: ROOT, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const pipe = (stream) => {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (tagged) log(tag, line);
        else process.stdout.write(`${line}\n`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('error', (error) => fail(error.code === 'ENOENT' ? `\`${command}\` ${NO_FOUNDRY}` : `${tag} failed to start: ${error.message}`));
  child.on('exit', (code) => {
    if (!stopping) fail(`${tag} exited unexpectedly (code ${code}). Stopping everything.`);
  });
  return child;
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  restoreRegistries();
  for (const child of children) killTree(child);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function run(tag, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  if (result.error?.code === 'ENOENT') fail(`\`${command}\` ${NO_FOUNDRY}`);
  if (result.status !== 0) {
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    fail(`${tag} failed.`);
  }
  return result.stdout;
}

async function listening(port) {
  const attempt = (host) =>
    new Promise((resolve) => {
      const socket = connect({ port, host });
      socket.setTimeout(1000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  const [v4, v6] = await Promise.all([attempt('127.0.0.1'), attempt('::1')]);
  return v4 || v6;
}

async function assertPortsFree() {
  const busy = [];
  for (const [name, port, env] of [
    ['hub', HUB_PORT, 'FORK_HUB_PORT'],
    ...SPOKES.map((s) => [s.name, s.port, s.portEnv]),
    ['server', SERVER_PORT, 'FORK_SERVER_PORT'],
    ['client', CLIENT_PORT, 'FORK_CLIENT_PORT'],
  ]) {
    if (await listening(port)) busy.push(`${name} :${port} (set ${env} to move it)`);
  }
  if (busy.length > 0) fail(`Ports already in use: ${busy.join(', ')}`);
}

/**
 * Asks every chain's fork RPC for its chain id before any anvil starts, so a
 * network the Alchemy app has not enabled (a 403 naming the network) stops
 * the start with what to do, rather than one anvil dying mid-start.
 */
async function checkForkSources() {
  const problems = [];
  for (const { name, url, urlEnv, alias } of [
    { name: 'Base', url: HUB_FORK_URL, urlEnv: 'FORK_BASE_RPC_URL' },
    ...SPOKES.map((s) => ({ name: s.name, url: s.forkUrl, urlEnv: s.urlEnv, alias: s.alias })),
  ]) {
    try {
      // A 429 is a burst limit, often left over from a run just stopped: wait it out a few times.
      let response;
      for (let attempt = 1; ; attempt++) {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status !== 429 || attempt === 5) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
      const body = await response.json().catch(() => ({}));
      if (body.result) continue;
      const message = String(body.error?.message ?? `HTTP ${response.status}`);
      const disabled = /not enabled for this app/i.test(message);
      problems.push(
        `${name}: ${disabled ? 'this network is not enabled on your Alchemy app (dashboard.alchemy.com → your app → Networks)' : masked(message)}. ` +
          `Or set ${urlEnv} to another archive RPC${alias ? `, or leave ${name} out with FORK_SPOKES=${SPOKES.filter((s) => s.alias !== alias).map((s) => s.alias).join(',') || 'arb'}` : ''}.`,
      );
    } catch (error) {
      problems.push(`${name}: ${masked(url)} did not answer (${reason(error)}). Set ${urlEnv} to another archive RPC.`);
    }
  }
  if (problems.length) fail(`Cannot fork every chain:\n  ${problems.join('\n  ')}`);
}

async function waitForAnvil(rpc, chainId, source) {
  const client = createPublicClient({ transport: http(rpc) });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const actual = await client.getChainId();
      if (actual === chainId) return;
      fail(`${masked(source)} is chain ${actual}, not ${chainId}.`);
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`anvil did not come up on ${rpc} within 90 s. Is ${masked(source)} reachable?`);
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function sendAndWait(client, wallet, request) {
  const hash = await wallet.writeContract({ chain: null, ...request });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${request.functionName} reverted (${hash})`);
  return receipt;
}

/** Runs `fn` as `address`, which anvil then signs for, with gas money. */
async function asImpersonated(url, address, fn) {
  await rpc(url, 'anvil_impersonateAccount', [address]);
  await rpc(url, 'anvil_setBalance', [address, numberToHex(parseEther('10'))]);
  try {
    return await fn(signerOn(url, address));
  } finally {
    await rpc(url, 'anvil_stopImpersonatingAccount', [address]);
  }
}

// -------------------------------------------------------------- registries

/**
 * The deploy scripts write `deployments/<chainId>.json`, which for a mainnet
 * is where the real chain's registry is committed. Each is set aside
 * before a deploy and put back after; the fork's own go to `deployments/fork/`.
 */
const setAside = new Map();

function backUpRegistry(chainId) {
  const file = `${DEPLOYMENTS}${chainId}.json`;
  const backup = `${FORK_DIR}${chainId}.real.json`;
  if (existsSync(file)) {
    copyFileSync(file, backup);
    setAside.set(chainId, backup);
  } else {
    setAside.set(chainId, null);
  }
}

/** Moves the registry a fork deploy wrote into `deployments/fork/`, and puts the real one back. */
function takeForkRegistry(chainId) {
  const file = `${DEPLOYMENTS}${chainId}.json`;
  if (!existsSync(file)) fail(`The deploy wrote no ${file}.`);
  renameSync(file, `${FORK_DIR}${chainId}.json`);
  restoreRegistry(chainId);
  return JSON.parse(readFileSync(`${FORK_DIR}${chainId}.json`, 'utf8'));
}

function restoreRegistry(chainId) {
  if (!setAside.has(chainId)) return;
  const backup = setAside.get(chainId);
  const file = `${DEPLOYMENTS}${chainId}.json`;
  if (backup) {
    copyFileSync(backup, file);
    rmSync(backup);
  } else if (existsSync(file)) {
    // Written by an interrupted fork deploy: nothing real was there.
    rmSync(file);
  }
  setAside.delete(chainId);
}

function restoreRegistries() {
  for (const chainId of [...setAside.keys()]) restoreRegistry(chainId);
}

// ------------------------------------------------------------------- steps

/** Every variable either deploy script reads; a value in the shell (or a `.env` someone exported) must not leak in. */
const DEPLOY_KEYS = [
  ...['SAFE', 'GUARDIAN', 'MULTISIG_PHASE_END', 'ATTESTOR', 'ATTESTORS', 'ATTESTOR_THRESHOLD', 'TIMELOCK_DELAY', 'MATCHMAKER'],
  ...['LMS_SUPPLY', 'STAKE_COOLDOWN', 'VOTING_DELAY', 'VOTING_PERIOD', 'PROPOSAL_THRESHOLD', 'QUORUM_PERCENT'],
  ...['STAKER_FEE_BPS', 'QUORUM_FLOOR', 'REWARD_DURATION', 'TEAM_BENEFICIARY', 'CHALLENGE_WINDOW'],
  ...['REWARDS_FIRST_EPOCH', 'MAX_REWARD_PER_ETH', 'MAX_REWARD_PER_WALLET', 'LMS_PER_ETH_DISCOUNT'],
  ...['ORACLE', 'ACROSS_SPOKE_POOL', 'MOCKS', 'POOL_MANAGER', 'SEQUENCER_FEED'],
  ...['VRF_SUBSCRIPTION_ID', 'VRF_COORDINATOR', 'VRF_KEY_HASH', 'VRF_CONFIRMATIONS', 'VRF_CALLBACK_GAS'],
  ...['HUB_CHAIN_ID', 'HUB_RECEIVER', 'HUB_WETH', 'SPOKE_POOL', 'SPOKE_OWNER', 'AVATARS', 'AVATAR_BASE_URI', 'AVATAR_MAX_SUPPLY'],
];

function runDeploy(script, url, settings) {
  const env = { ...process.env, DEPLOYER_PK: roles.deployer.key };
  for (const key of DEPLOY_KEYS) delete env[key];
  delete env.ETHERSCAN_API_KEY;
  Object.assign(env, settings);
  run('forge script', 'forge', ['script', script, '--rpc-url', url, '--broadcast', '--slow'], { cwd: CONTRACTS, env });
}

/** Clears EIP-7702 delegations the public test accounts carry on mainnet (sweepers), on every fork. */
async function clearTestAccounts() {
  for (let index = 0; index < FORK_ACCOUNT_COUNT; index++) {
    const { address } = forkAccount(index);
    for (const url of [HUB_RPC, ...SPOKES.map((spoke) => spoke.rpc)]) {
      await rpc(url, 'anvil_setCode', [address, '0x']);
      await rpc(url, 'anvil_setBalance', [address, numberToHex(parseEther('10000'))]);
    }
  }
}

/** As the Safe: a VRF v2.5 subscription on Base's real coordinator, funded with native ETH. */
async function createVrfSubscription() {
  const safe = signerOn(HUB_RPC, roles.safe.address);
  const receipt = await sendAndWait(hub, safe, { address: VRF_COORDINATOR, abi: coordinatorAbi, functionName: 'createSubscription' });
  const [created] = parseEventLogs({ abi: coordinatorAbi, eventName: 'SubscriptionCreated', logs: receipt.logs });
  if (!created) fail('The VRF coordinator emitted no SubscriptionCreated.');
  const subId = created.args.subId;
  await sendAndWait(hub, safe, {
    address: VRF_COORDINATOR,
    abi: coordinatorAbi,
    functionName: 'fundSubscriptionWithNative',
    args: [subId],
    value: parseEther('5'),
  });
  return subId;
}

function deployHub(subId) {
  backUpRegistry(HUB_CHAIN_ID);
  runDeploy('script/Deploy.s.sol:Deploy', HUB_RPC, {
    SAFE: roles.safe.address,
    GUARDIAN: roles.guardian.address,
    TEAM_BENEFICIARY: roles.team.address,
    ATTESTOR: roles.attestor.address,
    MATCHMAKER: roles.matchmaker.address,
    VRF_SUBSCRIPTION_ID: subId.toString(),
    POOL_MANAGER,
    MOCKS: 'false',
  });
  return takeForkRegistry(HUB_CHAIN_ID);
}

function deploySpoke(spoke, hubRegistry) {
  backUpRegistry(spoke.chainId);
  runDeploy('script/DeploySpoke.s.sol:DeploySpoke', spoke.rpc, {
    SPOKE_OWNER: roles.safe.address,
    HUB_CHAIN_ID: String(HUB_CHAIN_ID),
    HUB_RECEIVER: hubRegistry.contracts.bridgeReceiver,
  });
  return takeForkRegistry(spoke.chainId);
}

/** As the Safe at vrf.chain.link: Add Consumer. */
async function addVrfConsumer(subId, adapter) {
  await sendAndWait(hub, signerOn(HUB_RPC, roles.safe.address), {
    address: VRF_COORDINATOR,
    abi: coordinatorAbi,
    functionName: 'addConsumer',
    args: [subId, adapter],
  });
  const [, nativeBalance, , owner, consumers] = await hub.readContract({
    address: VRF_COORDINATOR,
    abi: coordinatorAbi,
    functionName: 'getSubscription',
    args: [subId],
  });
  if (owner.toLowerCase() !== roles.safe.address.toLowerCase() || !consumers.some((c) => c.toLowerCase() === adapter.toLowerCase())) {
    fail('The VRF subscription is not set up as expected.');
  }
  log('vrf', `subscription ${subId.toString().slice(0, 12)}… owned by the Safe, ${formatEther(nativeBalance)} ETH, consumer ${adapter}`);
}

/**
 * Plays the Chainlink node. No node answers on a fork and nobody can forge a
 * VRF proof, so each request is delivered the way the coordinator delivers
 * it — a call to the adapter's `rawFulfillRandomWords` from the coordinator's
 * address — once `VRF_CONFIRMATIONS` blocks have passed.
 */
function runVrfNode(adapter, from) {
  // Read with our own cursor rather than a node-side filter, which anvil can
  // drop without a word (the responder then hears nothing new, forever).
  const pending = new Map();
  let next = from;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const head = await hub.getBlockNumber();
      if (head >= next) {
        const logs = await hub.getContractEvents({ address: adapter, abi: adapterAbi, eventName: 'RandomnessRequested', fromBlock: next, toBlock: head });
        for (const { args, blockNumber } of logs) {
          if (!pending.has(args.vrfId)) pending.set(args.vrfId, { due: blockNumber + VRF_CONFIRMATIONS, context: args.context });
        }
        next = head + 1n;
      }
      for (const [vrfId, request] of pending) {
        if (head < request.due) continue;
        try {
          // Bounded: a send that never confirms must not hold every later request.
          await withTimeout(
            asImpersonated(HUB_RPC, VRF_COORDINATOR, (coordinator) =>
              sendAndWait(hub, coordinator, {
                address: adapter,
                abi: adapterAbi,
                functionName: 'rawFulfillRandomWords',
                args: [vrfId, [BigInt(toHex(randomBytes(32)))]],
              }),
            ),
            SEND_TIMEOUT_MS,
          );
          log('vrf', `seeded match ${request.context.slice(0, 10)}…`);
          pending.delete(vrfId);
        } catch (error) {
          // Already seeded (by hand, or a send that did land) or cancelled: done with it.
          if (/WrongStatus|NotOracle|reverted/.test(reason(error))) pending.delete(vrfId);
          log('vrf', `could not seed ${request.context.slice(0, 10)}…: ${reason(error)}`);
        }
      }
    } catch (error) {
      log('vrf', `could not read requests: ${reason(error)}`);
    } finally {
      busy = false;
    }
  }, 1_000).unref();
}

/** How long a keeper send on the fork may take before it is given up and tried again. */
const SEND_TIMEOUT_MS = 60_000;

/** `promise`, or a rejection once `ms` have passed without it settling. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const b32 = (address) => pad(address, { size: 32 });

/** Gives the Across relayer WETH on every chain and lets each pool take it. */
async function fundAcrossRelayer() {
  for (const [url, client, weth, pool] of [
    [HUB_RPC, hub, HUB_WETH, HUB_POOL],
    ...SPOKES.map((spoke) => [spoke.rpc, spoke.client, spoke.weth, spoke.pool]),
  ]) {
    const wallet = signerOn(url, roles.acrossRelayer.address);
    await sendAndWait(client, wallet, { address: weth, abi: wethAbi, functionName: 'deposit', value: parseEther('500') });
    await sendAndWait(client, wallet, { address: weth, abi: wethAbi, functionName: 'approve', args: [pool, 2n ** 256n - 1n] });
  }
}

/**
 * Plays an Across relayer between the hub and each spoke, both ways, on the
 * real SpokePools: reads each deposit our contracts make on one fork and,
 * `FILL_DELAY_MS` later, fills it on the other with `fillRelay`, which pays
 * the recipient and calls its handler with the deposit's message.
 */
function runAcrossRelayer(hubFrom, spokeHeads) {
  const hubSide = { url: HUB_RPC, client: hub, pool: HUB_POOL, chainId: HUB_CHAIN_ID };
  SPOKES.forEach((s, i) => {
    const spokeSide = { url: s.rpc, client: s.client, pool: s.pool, chainId: s.chainId };
    relay({ name: `${s.alias} → hub`, client: s.client, pool: s.pool, origin: s.chainId, from: spokeHeads[i] }, hubSide);
    relay({ name: `hub → ${s.alias}`, client: hub, pool: HUB_POOL, origin: HUB_CHAIN_ID, from: hubFrom }, spokeSide);
  });
}

/**
 * One fill at a time per destination chain: two sent at once from the
 * relayer's one account take the same nonce, and one of them is dropped.
 * Three spokes all fill on the hub, so the queue is the chain's, not the route's.
 */
const fillQueues = new Map();

function relay(source, destination) {
  const wallet = signerOn(destination.url, roles.acrossRelayer.address);
  let next = source.from;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const head = await source.client.getBlockNumber();
      if (head < next) return;
      const logs = await source.client.getLogs({
        address: source.pool,
        event: fundsDeposited,
        // Across records the player as the depositor, not our contract, and
        // nothing else deposits on a fork: every deposit to the other chain is ours.
        args: { destinationChainId: BigInt(destination.chainId) },
        fromBlock: next,
        toBlock: head,
      });
      next = head + 1n;
      for (const { args } of logs) {
        log('across', `${source.name}: deposit ${args.depositId} of ${formatEther(args.inputAmount)} ETH, filling ${formatEther(args.outputAmount)} in ${FILL_DELAY_MS / 1000}s…`);
        setTimeout(() => queueFill(args), FILL_DELAY_MS);
      }
    } catch (error) {
      log('across', `${source.name}: could not read deposits: ${reason(error)}`);
    } finally {
      busy = false;
    }
  }, 1_500).unref();

  const queueFill = (deposit, attempt = 1) => {
    const queued = (fillQueues.get(destination.url) ?? Promise.resolve()).then(() => fill(deposit, attempt));
    fillQueues.set(destination.url, queued);
  };

  const fill = async (deposit, attempt) => {
    try {
      await withTimeout(sendAndWait(destination.client, wallet, {
        address: destination.pool,
        abi: fillAbi,
        functionName: 'fillRelay',
        args: [
          {
            depositor: deposit.depositor,
            recipient: deposit.recipient,
            exclusiveRelayer: deposit.exclusiveRelayer,
            inputToken: deposit.inputToken,
            outputToken: deposit.outputToken,
            inputAmount: deposit.inputAmount,
            outputAmount: deposit.outputAmount,
            originChainId: BigInt(source.origin),
            depositId: deposit.depositId,
            fillDeadline: deposit.fillDeadline,
            exclusivityDeadline: deposit.exclusivityDeadline,
            message: deposit.message,
          },
          BigInt(destination.chainId),
          b32(roles.acrossRelayer.address),
        ],
      }), SEND_TIMEOUT_MS);
      log('across', `${source.name}: deposit ${deposit.depositId} filled`);
    } catch (error) {
      log('across', `${source.name}: deposit ${deposit.depositId} could not be filled (try ${attempt}): ${reason(error)}`);
      // A real relayer tries again; one that never fills leaves the stake to the deposit's expiry.
      if (attempt < FILL_ATTEMPTS) setTimeout(() => queueFill(deposit, attempt + 1), FILL_DELAY_MS);
    }
  };
}

/** The first route the real quoter prices for each candidate token, at this fork block. */
async function liveTokens() {
  const tokens = [];
  for (const candidate of TOKEN_CANDIDATES) {
    let found = null;
    for (const hops of candidate.paths) {
      const path = hops.map(([intermediateCurrency, fee, tickSpacing]) => ({ intermediateCurrency, fee, tickSpacing, hooks: zeroAddress, hookData: '0x' }));
      try {
        const { result } = await hub.simulateContract({
          address: V4_QUOTER,
          abi: quoterAbi,
          functionName: 'quoteExactOutput',
          args: [{ exactCurrency: zeroAddress, path, exactAmount: parseEther('0.01') }],
        });
        found = { path, quote: result[0] };
        break;
      } catch {
        // No pool, or no liquidity at this fork block: try the next route.
      }
    }
    if (!found) {
      log('fork', `${candidate.symbol}: no live Uniswap v4 route to ETH at this block — not offered.`);
      continue;
    }
    log('fork', `${candidate.symbol}: 0.01 ETH costs ${formatUnits(found.quote, candidate.decimals)} via ${found.path.map((p) => `${p.fee / 1e4}%`).join(' → ')}`);
    tokens.push({
      symbol: candidate.symbol,
      address: candidate.address,
      decimals: candidate.decimals,
      funding: candidate.funding,
      path: found.path.map(({ intermediateCurrency, fee, tickSpacing }) => ({ intermediateCurrency, fee, tickSpacing })),
    });
  }
  return tokens;
}

/** Writes a balance straight into the token's balances mapping, finding its slot by trying. */
async function fundToken(token, holder) {
  const amount = parseUnits(token.funding, token.decimals);
  const read = () => hub.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
  if (token.slot === undefined) {
    for (let slot = 0n; slot < 64n; slot++) {
      const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]));
      const before = await rpc(HUB_RPC, 'eth_getStorageAt', [token.address, key, 'latest']);
      await rpc(HUB_RPC, 'anvil_setStorageAt', [token.address, key, pad(numberToHex(amount), { size: 32 })]);
      if ((await read()) === amount) {
        token.slot = slot;
        return;
      }
      await rpc(HUB_RPC, 'anvil_setStorageAt', [token.address, key, pad(before, { size: 32 })]);
    }
    fail(`Could not find ${token.symbol}'s balance slot.`);
  }
  const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, token.slot]));
  await rpc(HUB_RPC, 'anvil_setStorageAt', [token.address, key, pad(numberToHex(amount), { size: 32 })]);
  if ((await read()) !== amount) fail(`Funding ${token.symbol} missed for ${holder}.`);
}

/**
 * LMS for every player, from the treasury: some liquid, the rest staked for
 * them. On a real deployment that would be a grant proposal; here the timelock
 * is impersonated, as is switching on what Base leaves off by default.
 */
async function seedGovernance(contracts) {
  const staked = parseEther(PLAYER_STAKED_LMS);
  const liquid = parseEther(PLAYER_LIQUID_LMS);
  const total = (staked + liquid) * BigInt(players.length);
  const funder = signerOn(HUB_RPC, roles.outsider.address);

  await asImpersonated(HUB_RPC, contracts.timelock, async (timelock) => {
    await sendAndWait(hub, timelock, { address: contracts.lmsToken, abi: erc20Abi, functionName: 'transfer', args: [roles.outsider.address, total] });
    if (!MAINNET_ECONOMICS) {
      await sendAndWait(hub, timelock, { address: contracts.feeRouter, abi: abiOf('FeeRouter'), functionName: 'setStakerBps', args: [DEMO_STAKER_BPS] });
      await sendAndWait(hub, timelock, { address: contracts.config, abi: abiOf('ProtocolConfig'), functionName: 'setLmsPerEthDiscount', args: [DEMO_LMS_PER_ETH] });
    }
  });

  await sendAndWait(hub, funder, { address: contracts.lmsToken, abi: erc20Abi, functionName: 'approve', args: [contracts.stakedLms, staked * BigInt(players.length)] });
  for (const player of players) {
    await sendAndWait(hub, funder, { address: contracts.stakedLms, abi: abiOf('StakedLms'), functionName: 'depositFor', args: [player.address, staked] });
    await sendAndWait(hub, funder, { address: contracts.lmsToken, abi: erc20Abi, functionName: 'transfer', args: [player.address, liquid] });
  }
}

/**
 * The match analyst's settings (`GEMINI_API_KEY` and the rest of `GEMINI_*`
 * and `ANALYST_*`), from the shell or `.env`. The rest of `.env` stays out:
 * it names the real database and the real chain.
 */
function analystEnv() {
  return Object.fromEntries(Object.entries(readDotEnv()).filter(([name, value]) => /^(GEMINI_|ANALYST_)/.test(name) && value !== ''));
}

/** Mines on a timer from now on, like the real chains, so confirmations and block-based waits progress on their own. */
async function startIntervalMining() {
  await rpc(HUB_RPC, 'evm_setIntervalMining', [2]);
  for (const spoke of SPOKES) await rpc(spoke.rpc, 'evm_setIntervalMining', [spoke.blockSeconds]);
}

// -------------------------------------------------------------------- main

async function main() {
  await assertPortsFree();
  mkdirSync(FORK_DIR, { recursive: true });

  log('fork', 'Building the TypeScript packages…');
  run('tsc --build', process.execPath, ['node_modules/typescript/bin/tsc', '--build']);

  log('fork', `Forking Base from ${masked(HUB_FORK_URL)}${SPOKES.map((s) => `, ${s.name} from ${masked(s.forkUrl)}`).join('')}…`);
  if (!ALCHEMY_KEY && !process.env.FORK_BASE_RPC_URL) {
    log('fork', 'No archive RPC: public endpoints stop serving the fork block after a few minutes. Set ALCHEMY_API_KEY, or FORK_BASE_RPC_URL and each FORK_<ARB|OP|ETH>_RPC_URL.');
  }
  await checkForkSources();
  const cups = String(forkCups(1 + SPOKES.length));
  const anvilArgs = (url, port) => ['--fork-url', url, '--port', String(port), '--accounts', String(FORK_ACCOUNT_COUNT), '--compute-units-per-second', cups, '--retries', '10', '--quiet'];
  start('hub', 'anvil', anvilArgs(HUB_FORK_URL, HUB_PORT));
  for (const spoke of SPOKES) start(spoke.alias, 'anvil', anvilArgs(spoke.forkUrl, spoke.port));
  await waitForAnvil(HUB_RPC, HUB_CHAIN_ID, HUB_FORK_URL);
  for (const spoke of SPOKES) await waitForAnvil(spoke.rpc, spoke.chainId, spoke.forkUrl);
  await clearTestAccounts();

  log('fork', 'As the Safe: creating and funding a VRF v2.5 subscription on Chainlink’s Base coordinator…');
  const subId = await createVrfSubscription();

  log('fork', 'Deploying the hub with Deploy.s.sol, production path (compiles on first run)…');
  const hubRegistry = deployHub(subId);
  const c = hubRegistry.contracts;
  log('fork', `GameEscrow ${c.escrow} · VRF adapter ${c.randomnessOracle} · receiver ${c.bridgeReceiver} · ZapJoin ${c.zapJoin}`);

  log('fork', 'As the Safe: adding the VRF adapter as a consumer…');
  await addVrfConsumer(subId, c.randomnessOracle);

  for (const spoke of SPOKES) {
    log('fork', `Deploying the spoke on ${spoke.name} with DeploySpoke.s.sol…`);
    spoke.registry = deploySpoke(spoke, hubRegistry);
    log('fork', `${spoke.name}: SpokeRouter ${spoke.registry.contracts.spokeRouter} · avatars ${spoke.registry.contracts.avatars}`);
  }

  log('fork', 'Funding the Across relayer, the players and governance…');
  await fundAcrossRelayer();
  const tokens = await liveTokens();
  for (const player of players) {
    for (const token of tokens) await fundToken(token, player.address);
  }
  await seedGovernance(c);

  const [hubHead, ...spokeHeads] = await Promise.all([hub.getBlockNumber(), ...SPOKES.map((spoke) => spoke.client.getBlockNumber())]);
  runVrfNode(c.randomnessOracle, hubHead + 1n);
  runAcrossRelayer(hubHead + 1n, spokeHeads.map((head) => head + 1n));
  await startIntervalMining();

  const first = SPOKES[0];
  const profile = {
    net: 'fork',
    createdAt: new Date().toISOString(),
    hub: { chainId: HUB_CHAIN_ID, name: 'Base (fork)', rpc: HUB_RPC },
    // The first spoke, as `--from spoke` means it; `spokes` has every one.
    spoke: { chainId: first.chainId, name: `${first.name} (fork)`, rpc: first.rpc },
    spokes: SPOKES.map((spoke) => ({
      chainId: spoke.chainId,
      alias: spoke.alias,
      name: `${spoke.name} (fork)`,
      rpc: spoke.rpc,
      contracts: spoke.registry.contracts,
      deployBlock: spoke.registry.deployBlock,
      pool: spoke.pool,
      weth: spoke.weth,
    })),
    ws: WS_URL,
    client: `http://localhost:${CLIENT_PORT}`,
    deployBlock: hubRegistry.deployBlock,
    spokeDeployBlock: first.registry.deployBlock,
    contracts: c,
    spokeContracts: first.registry.contracts,
    vrf: { coordinator: VRF_COORDINATOR, subId: subId.toString() },
    across: { hubPool: HUB_POOL, spokePool: first.pool, hubWeth: HUB_WETH, spokeWeth: first.weth, api: null },
    tokens,
    tiers: MATCHMAKING_TIERS,
    roles,
    players,
  };
  writeFileSync(`${FORK_DIR}profile.json`, `${JSON.stringify(profile, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);

  start('server', process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', '--clear-screen=false', 'packages/server/src/main.ts'], {
    tagged: false,
    env: {
      ...process.env,
      ...analystEnv(),
      // Never the developer's real database from a shell that exported `.env`:
      // in memory unless FORK_DATABASE_URL names one for the fork alone. In
      // memory, a server restart refunds live matches instead of resuming them.
      DATABASE_URL: process.env.FORK_DATABASE_URL || '',
      ...(process.env.FORK_DATABASE_URL ? {} : { ARCHIVE: 'memory' }),
      NODE_ENV: 'development',
      ALLOWED_ORIGINS: '',
      WS_PORT: String(SERVER_PORT),
      CHAIN_ID: String(HUB_CHAIN_ID),
      RPC_URL: HUB_RPC,
      DEPLOYMENTS_DIR: FORK_DIR,
      ESCROW_ADDRESS: c.escrow,
      ATTESTOR_PK: roles.attestor.key,
      KEEPER_PK: roles.keeper.key,
      MATCHMAKER_PK: roles.matchmaker.key,
      SESSION_RELAYER_PK: roles.sessionRelayer.key,
      SESSION_DELEGATE: c.sessionDelegate,
      COMMIT_MS: process.env.COMMIT_MS || '60000',
      REVEAL_MS: process.env.REVEAL_MS || '15000',
      CONFIRMATIONS: '1',
      MATCHMAKING_TIERS: JSON.stringify(MATCHMAKING_TIERS),
      MATCHMAKING_FILL_AFTER_MS: '15000',
      // Eight tabs and a handful of bots, all from one IP.
      GATEWAY_LIMITS: JSON.stringify({ connectRatePerIp: 50, connectBurstPerIp: 100, loginRatePerIp: 50, loginBurstPerIp: 100 }),
      ZAP_JOIN: c.zapJoin,
      V4_QUOTER,
      ZAP_TOKENS: JSON.stringify(tokens.map(({ symbol, address, decimals, path }) => ({ symbol, address, decimals, path }))),
      FEE_ROUTER: c.feeRouter,
      FEE_KEEPER_POLL_MS: '10000',
      HARVEST_MIN_WEI: '1',
      STAKED_LMS: c.stakedLms,
      REWARDS_DISTRIBUTOR: c.rewardsDistributor,
      GOVERNOR_ADDRESS: c.governor,
      GOVERNOR_FROM_BLOCK: String(hubRegistry.deployBlock),
      AVATAR_COLLECTIONS: JSON.stringify([
        { chainId: HUB_CHAIN_ID, address: c.avatars, rpcUrl: HUB_RPC },
        ...SPOKES.map((spoke) => ({ chainId: spoke.chainId, address: spoke.registry.contracts.avatars, rpcUrl: spoke.rpc })),
      ]),
      SPOKES: JSON.stringify(SPOKES.map((spoke) => ({ chainId: spoke.chainId, router: spoke.registry.contracts.spokeRouter }))),
      CROSS_CHAIN_FROM_BLOCK: String(hubRegistry.deployBlock),
    },
  });

  start('client', process.execPath, ['node_modules/vite/bin/vite.js', 'packages/client', '--port', String(CLIENT_PORT), '--strictPort', '--clearScreen', 'false'], {
    env: {
      ...process.env,
      VITE_WS_URL: WS_URL,
      VITE_RPC_URL: HUB_RPC,
      VITE_SPOKE_RPC_URL: first.rpc,
      // By chain id and by alias: `&chain=10` or `&chain=op`.
      VITE_SPOKE_RPC_URLS: JSON.stringify(Object.fromEntries(SPOKES.flatMap((spoke) => [[spoke.chainId, spoke.rpc], [spoke.alias, spoke.rpc]]))),
      VITE_ACROSS_API: '',
      VITE_DEV_KEY: players[0].key,
      VITE_DEV_KEYS: players.map((p) => p.key).join(','),
    },
  });

  const url = `http://localhost:${CLIENT_PORT}`;
  log('fork', '');
  log('fork', `\x1b[1mReady → ${url}/?player=1 … ${url}/?player=8\x1b[0m`);
  log('fork', `Stake from a spoke with &chain=${SPOKES.map((spoke) => `${spoke.alias} (${spoke.name})`).join(', ')}`);
  log('fork', `One seat per chain: ${['?player=1', ...SPOKES.map((spoke, i) => `?player=${i + 2}&chain=${spoke.alias}`)].map((q) => `${url}/${q}`).join('  ')}`);
  log('fork', `Players (10,000 ETH on every fork; ${tokens.map((t) => `${t.funding} ${t.symbol}`).join(', ')}; ${PLAYER_LIQUID_LMS} LMS; ${PLAYER_STAKED_LMS} sLMS):`);
  for (const player of players) log('fork', `  P${player.n}  ${player.address}`);
  log('fork', MAINNET_ECONOMICS ? 'Economics: Base defaults (no stakers’ share, no LMS discount).' : `Economics: stakers get ${DEMO_STAKER_BPS / 100}% of fees, LMS discount on (set as the timelock).`);
  log('fork', 'In another terminal: npm run play -- help');
  log('fork', 'Ctrl+C stops everything.');
}

main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
