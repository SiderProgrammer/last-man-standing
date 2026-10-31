#!/usr/bin/env node
/**
 * `npm run dev:fork` — the whole staked stack on a local mainnet fork, in one command.
 *
 * Practice mode needs no chain; everything that touches one — staked lobbies,
 * settlement, paying in tokens through Uniswap v4 — needs real contracts, and
 * token payment in particular needs real pools with real liquidity. A mainnet
 * fork has both for free, so this:
 *
 *   1. builds the TypeScript packages the server runs from,
 *   2. starts anvil forking mainnet, as chain 31337,
 *   3. deploys the protocol with `Deploy.s.sol`, including `ZapJoin` against
 *      the real v4 `PoolManager`, plus the staking, fee and governance contracts,
 *   4. plays the randomness oracle: every `lockMatch` gets its seed a block
 *      later, as it would from Chainlink VRF,
 *   5. funds the browser's dev burner (and `FORK_PLAYER`, if set) with USDC,
 *      USDT and DAI, and opens two lobbies,
 *   6. starts a second, plain anvil as a spoke chain (31338) and deploys
 *      `SpokeRouter` there with `DeploySpoke.s.sol`, over a mock Across
 *      SpokePool; the hub deploy has its own mock pool and `BridgeJoinReceiver`,
 *   7. plays an Across relayer between the two: every deposit made on the
 *      spoke is filled on the hub a few seconds later, as it would be for real,
 *   8. starts the server and the client wired to all of it.
 *
 * Ctrl+C stops everything. Nothing is written outside `contracts/broadcast/`
 * and `contracts/deployments/`, both gitignored, and no `.env` is read or
 * written. Delete `contracts/deployments/31337.json` before `forge test`:
 * `Deploy.t.sol` checks that a test run writes no registry there.
 *
 * Environment (all optional):
 *   FORK_RPC_URL      mainnet RPC to fork     default: https://ethereum-rpc.publicnode.com
 *   FORK_PLAYER       an address to fund too, e.g. your wallet extension's account
 *   FORK_ANVIL_PORT   default 8545
 *   FORK_SPOKE_PORT   the spoke anvil, default 8546
 *   FORK_FILL_DELAY_MS  how long a spoke join waits for its fill, default 5000
 *   FORK_SERVER_PORT  default 8788, so it does not collide with a normal `npm run dev` on 8787
 *   FORK_CLIENT_PORT  default 5174, likewise beside 5173
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  numberToHex,
  pad,
  parseEther,
  parseUnits,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { artifactPath } from './artifacts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = fileURLToPath(new URL('../contracts/', import.meta.url));

const FORK_RPC_URL = process.env.FORK_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const ANVIL_PORT = Number(process.env.FORK_ANVIL_PORT || 8545);
const SPOKE_PORT = Number(process.env.FORK_SPOKE_PORT || 8546);
const SERVER_PORT = Number(process.env.FORK_SERVER_PORT || 8788);
const CLIENT_PORT = Number(process.env.FORK_CLIENT_PORT || 5174);
const EXTRA_PLAYER = process.env.FORK_PLAYER || '';
const FILL_DELAY_MS = Number(process.env.FORK_FILL_DELAY_MS || 5_000);

const CHAIN_ID = 31337;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const SPOKE_CHAIN_ID = 31338;
const SPOKE_RPC = `http://127.0.0.1:${SPOKE_PORT}`;

// Anvil's first default accounts, from its public test mnemonic. They are
// funded on every anvil node and worthless anywhere else.
/** Deploys, attests results, and creates the seed lobbies. */
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** The browser's dev burner, used when no wallet extension is installed. */
const PLAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
/**
 * Sends the server's transactions: lock, settle, finalise, harvest. Its own
 * key, as the server requires: the attestor only signs.
 */
const KEEPER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
/**
 * Opens matchmade lobbies. Anvil's fourth account, which `Deploy.s.sol` makes
 * the matchmaker on a local node when `MATCHMAKER` is unset.
 */
const MATCHMAKER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
/**
 * Pays the hub gas of one-click calls and of withdrawals to the spoke that
 * players sign: the server's session relayer. Anvil's fifth account.
 */
const SESSION_RELAYER_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

/**
 * Answers the mock oracle. A different anvil dev account from the operator,
 * which the server also signs with, so the two never race for a nonce; and an
 * unlocked one, so anvil signs for it and no key is needed here.
 */
const ORACLE_NODE = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';
/** Plays the Across relayer on both chains. Another unlocked anvil account, for the same reason. */
const RELAYER = '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f';

// Uniswap v4 on mainnet.
const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';
const V4_QUOTER = '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

/**
 * Offered tokens, their routes to ETH, and where each keeps its balances so a
 * wallet can be funded by writing storage. DAI has no direct v4 pool with
 * ETH, which makes it the multi-hop example: DAI → USDC → ETH.
 */
const TOKENS = [
  {
    symbol: 'USDC',
    address: USDC,
    decimals: 6,
    balanceSlot: 9n,
    path: [{ intermediateCurrency: USDC, fee: 500, tickSpacing: 10 }],
  },
  {
    symbol: 'USDT',
    address: USDT,
    decimals: 6,
    balanceSlot: 2n,
    path: [{ intermediateCurrency: USDT, fee: 500, tickSpacing: 10 }],
  },
  {
    symbol: 'DAI',
    address: DAI,
    decimals: 18,
    balanceSlot: 2n,
    path: [
      { intermediateCurrency: DAI, fee: 100, tickSpacing: 1 },
      { intermediateCurrency: USDC, fee: 500, tickSpacing: 10 },
    ],
  },
];
const TOKEN_FUNDING = '1000';

const LOBBIES = [
  { stake: '0.01', seats: 4 },
  { stake: '0.05', seats: 6 },
];

/**
 * A contract's ABI from Foundry's build output. Read on use, not at load:
 * `forge script` compiles the contracts first.
 */
const abiOf = (contract) =>
  JSON.parse(readFileSync(artifactPath(`${CONTRACTS}out/`, contract), 'utf8')).abi;
/** Staked by the operator: enough to clear the 100,000 sLMS proposal threshold. */
const OPERATOR_STAKE = '200000';
/** Staked for each funded player, so they can vote on the demo proposal from the start. */
const PLAYER_STAKE = '1000';
const DEMO_PROPOSAL = [
  "# Raise the stakers' share of fees to 60%",
  '',
  'A demo proposal created by `npm run dev:fork`. Voting opens a minute after',
  'the fork starts and closes thirty minutes later.',
].join('\n');

const children = [];
let stopping = false;

// ------------------------------------------------------------------ output

const COLORS = { anvil: 90, spoke: 90, server: 36, client: 35, fork: 32, oracle: 33, across: 34 };

function log(tag, line) {
  process.stdout.write(`\x1b[${COLORS[tag] ?? 0}m[${tag}]\x1b[0m ${line}\n`);
}

function fail(message) {
  log('fork', `\x1b[31m${message}\x1b[0m`);
  shutdown(1);
}

// --------------------------------------------------------------- processes

/** `tagged: false` for a process that already prefixes its own lines, as the server does. */
function start(tag, command, args, { tagged = true, ...options } = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
        else process.stdout.write(`${line}
`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('error', (error) => {
    fail(
      error.code === 'ENOENT'
        ? `\`${command}\` was not found. Install Foundry (https://getfoundry.sh) and make sure it is on PATH.`
        : `${tag} failed to start: ${error.message}`,
    );
  });
  child.on('exit', (code) => {
    if (!stopping) fail(`${tag} exited unexpectedly (code ${code}). Stopping everything.`);
  });
  return child;
}

/** `child.kill` leaves grandchildren behind on Windows, and `tsx watch` has one. */
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function run(tag, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  if (result.error?.code === 'ENOENT') {
    fail(`\`${command}\` was not found. Install Foundry (https://getfoundry.sh) and make sure it is on PATH.`);
  }
  if (result.status !== 0) {
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    fail(`${tag} failed.`);
  }
  return result.stdout;
}

// ------------------------------------------------------------------- steps

async function assertPortsFree() {
  const busy = [];
  for (const [name, port] of [
    ['anvil', ANVIL_PORT],
    ['spoke', SPOKE_PORT],
    ['server', SERVER_PORT],
    ['client', CLIENT_PORT],
  ]) {
    if (await listening(port)) busy.push(`${name} :${port} (set FORK_${name.toUpperCase()}_PORT to move it)`);
  }
  if (busy.length > 0) fail(`Ports already in use: ${busy.join(', ')}`);
}

/**
 * True when anything accepts a connection on the port, over IPv4 or IPv6.
 * Connecting rather than trying to bind: Vite listens on `::1` and the server
 * on `::`, and a bind to `127.0.0.1` succeeds beside either of them.
 */
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

async function waitForAnvil(publicClient, chainId = CHAIN_ID, rpc = RPC) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await publicClient.getChainId()) === chainId) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`anvil did not come up on ${rpc} within 60 s.${chainId === CHAIN_ID ? ` Is ${FORK_RPC_URL} reachable?` : ''}`);
}

/** Every variable either deploy script reads; a value left in the shell must not leak in. */
const DEPLOY_KEYS = [
  ...['SAFE', 'GUARDIAN', 'MULTISIG_PHASE_END', 'ATTESTOR', 'ATTESTORS', 'ATTESTOR_THRESHOLD', 'TIMELOCK_DELAY'],
  ...['LMS_SUPPLY', 'STAKE_COOLDOWN', 'VOTING_DELAY', 'VOTING_PERIOD', 'PROPOSAL_THRESHOLD', 'QUORUM_PERCENT'],
  ...['STAKER_FEE_BPS', 'QUORUM_FLOOR', 'REWARD_DURATION', 'TEAM_BENEFICIARY'],
  ...['REWARDS_FIRST_EPOCH', 'MAX_REWARD_PER_ETH', 'MAX_REWARD_PER_WALLET', 'LMS_PER_ETH_DISCOUNT'],
  ...['ORACLE', 'ACROSS_SPOKE_POOL'],
  ...['HUB_CHAIN_ID', 'HUB_RECEIVER', 'HUB_WETH', 'SPOKE_POOL', 'SPOKE_OWNER', 'AVATARS'],
];

/** Registry keys, as the contract names the rest of this script uses. */
const REGISTRY_NAMES = {
  config: 'ProtocolConfig',
  escrow: 'GameEscrow',
  avatars: 'PlayerAvatars',
  sessionDelegate: 'SessionKeyDelegate',
  zapJoin: 'ZapJoin',
  timelock: 'TimelockController',
  lmsToken: 'LmsToken',
  stakedLms: 'StakedLms',
  governor: 'LmsGovernor',
  feeRouter: 'FeeRouter',
  rewardsDistributor: 'RewardsDistributor',
  randomnessOracle: 'MockRandomnessOracle',
  bridgeReceiver: 'BridgeJoinReceiver',
  acrossSpokePool: 'MockAcrossSpokePool',
  weth: 'MockWETH',
  spokeRouter: 'SpokeRouter',
};

/**
 * The contracts a deploy created, by name, from the `deployments/<chainId>.json`
 * it wrote. Not from the broadcast log: with GameEscrow under its own compiler
 * profile, forge leaves most contract names there blank.
 */
function created(chainId) {
  const registry = JSON.parse(
    readFileSync(new URL(`../contracts/deployments/${chainId}.json`, import.meta.url), 'utf8'),
  );
  const addresses = { deployBlock: registry.deployBlock };
  for (const [key, address] of Object.entries(registry.contracts)) {
    addresses[REGISTRY_NAMES[key] ?? key] = address;
  }
  return addresses;
}

function deploy() {
  const env = { ...process.env, DEPLOYER_PK: OPERATOR_KEY, POOL_MANAGER };
  for (const key of DEPLOY_KEYS) {
    delete env[key];
  }
  // Votes that open in a minute and last half an hour, so a proposal can be
  // voted on, and run to completion, in one sitting.
  env.VOTING_DELAY = '60';
  env.VOTING_PERIOD = '1800';
  // Low enough that each dev player's 1,000 staked LMS can make a proposal.
  env.PROPOSAL_THRESHOLD = parseEther(PLAYER_STAKE).toString();
  // The production floor is 1M sLMS; the operator's demo stake has to clear it.
  env.QUORUM_FLOOR = parseEther(PLAYER_STAKE).toString();
  // Staker rewards stream over an hour, not a week, so they visibly accrue.
  env.REWARD_DURATION = '3600';
  run('forge script', 'forge', ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', RPC, '--broadcast'], {
    cwd: CONTRACTS,
    env,
  });

  // `deployBlock` is where the server starts looking for proposals.
  const addresses = created(CHAIN_ID);
  const required = ['GameEscrow', 'ZapJoin', 'MockRandomnessOracle', 'FeeRouter', 'BridgeJoinReceiver', 'MockAcrossSpokePool', 'MockWETH'];
  const missing = required.filter((name) => !addresses[name]);
  if (missing.length > 0) fail(`Deploy did not produce: ${missing.join(', ')}.`);
  return addresses;
}

/** `DeploySpoke.s.sol` on the spoke anvil, pointed at the hub just deployed. */
function deploySpoke(hub) {
  const env = { ...process.env, DEPLOYER_PK: OPERATOR_KEY };
  for (const key of DEPLOY_KEYS) {
    delete env[key];
  }
  Object.assign(env, {
    HUB_CHAIN_ID: String(CHAIN_ID),
    HUB_RECEIVER: hub.BridgeJoinReceiver,
    // The hub's mock WETH: a local chain is not in `config/across.json`.
    HUB_WETH: hub.MockWETH,
  });
  run('forge script', 'forge', ['script', 'script/DeploySpoke.s.sol:DeploySpoke', '--rpc-url', SPOKE_RPC, '--broadcast'], {
    cwd: CONTRACTS,
    env,
  });
  const spoke = created(SPOKE_CHAIN_ID);
  const missing = ['SpokeRouter', 'MockAcrossSpokePool', 'PlayerAvatars'].filter((name) => !spoke[name]);
  if (missing.length > 0) fail(`DeploySpoke did not produce: ${missing.join(', ')}.`);
  return spoke;
}

/**
 * Plays an Across relayer, both ways: reads each deposit made into one
 * chain's mock pool and, `FILL_DELAY_MS` later, fills it on the other's —
 * paying the recipient and calling its handler with the deposit's message,
 * which is what a relayer and the real SpokePool do. Joins go spoke to hub;
 * withdrawals to the spoke go hub to spoke. The delay is there so the
 * client's "in transit" state can be seen.
 */
function runRelayer(hub, spoke) {
  relayDeposits({ name: 'the hub', rpc: SPOKE_RPC, pool: spoke.MockAcrossSpokePool }, { rpc: RPC, pool: hub.MockAcrossSpokePool, chainId: CHAIN_ID });
  relayDeposits({ name: 'the spoke', rpc: RPC, pool: hub.MockAcrossSpokePool }, { rpc: SPOKE_RPC, pool: spoke.MockAcrossSpokePool, chainId: SPOKE_CHAIN_ID });
}

function relayDeposits(from, to) {
  const source = createPublicClient({ transport: http(from.rpc) });
  const relayer = createWalletClient({ account: RELAYER, transport: http(to.rpc) });
  const pool = abiOf('MockAcrossSpokePool');
  let next = 0n;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const count = await source.readContract({ address: from.pool, abi: pool, functionName: 'depositCount' });
      for (; next < count; next++) {
        const deposit = await source.readContract({ address: from.pool, abi: pool, functionName: 'getDeposit', args: [next] });
        if (deposit.destinationChainId !== BigInt(to.chainId)) continue;
        const index = next;
        log('across', `deposit ${index} waiting for a fill: ${formatUnits(deposit.outputAmount, 18)} ETH to ${from.name}…`);
        setTimeout(() => void fill(index, deposit), FILL_DELAY_MS);
      }
    } catch (error) {
      log('across', `could not read deposits for ${from.name}: ${error.shortMessage ?? error.message}`);
    } finally {
      busy = false;
    }
  };

  const fill = async (index, deposit) => {
    try {
      await relayer.writeContract({
        chain: null,
        address: to.pool,
        abi: pool,
        functionName: 'fill',
        args: [deposit.recipient, deposit.outputToken, deposit.outputAmount, deposit.fillDeadline, deposit.message],
        value: deposit.outputAmount,
      });
      log('across', `deposit ${index} to ${from.name} filled`);
    } catch (error) {
      log('across', `deposit ${index} to ${from.name} could not be filled: ${error.shortMessage ?? error.message}`);
    }
  };

  setInterval(() => void tick(), 1_500).unref();
}

async function rpc(method, params, url = RPC) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Writes a token balance straight into its `balances` mapping, then checks it landed. */
async function fundToken(publicClient, token, holder) {
  const amount = parseUnits(TOKEN_FUNDING, token.decimals);
  const slot = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, token.balanceSlot]),
  );
  await rpc('anvil_setStorageAt', [token.address, slot, pad(numberToHex(amount), { size: 32 })]);

  const balance = await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [holder],
  });
  if (balance !== amount) {
    fail(`Funding ${token.symbol} missed: its balance slot is not ${token.balanceSlot} on this fork.`);
  }
}

async function seed(publicClient, escrow) {
  const player = privateKeyToAccount(PLAYER_KEY).address;
  const holders = [player];
  // Anvil's dev keys are public, and on mainnet someone has delegated these
  // accounts (EIP-7702) to a sweeper that forwards every incoming wei
  // elsewhere. The fork inherits that code, so winnings, fee shares and staking
  // rewards would vanish the moment they arrived. Clear it: these accounts are
  // plain EOAs here. `FORK_PLAYER` is left alone; its delegation, if any, is
  // its owner's.
  for (const account of [player, privateKeyToAccount(OPERATOR_KEY).address]) {
    await rpc('anvil_setCode', [account, '0x']);
  }
  if (EXTRA_PLAYER) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(EXTRA_PLAYER)) fail(`FORK_PLAYER is not an address: ${EXTRA_PLAYER}`);
    holders.push(EXTRA_PLAYER);
    await rpc('anvil_setBalance', [EXTRA_PLAYER, numberToHex(parseEther('100'))]);
    // And on the spoke, to stake from there. The dev burner is an anvil
    // account, funded on every anvil node already.
    await rpc('anvil_setBalance', [EXTRA_PLAYER, numberToHex(parseEther('100'))], SPOKE_RPC);
  }
  for (const holder of holders) {
    for (const token of TOKENS) await fundToken(publicClient, token, holder);
  }

  const operator = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), transport: http(RPC) });
  for (const lobby of LOBBIES) {
    const hash = await operator.writeContract({
      chain: null,
      address: escrow,
      abi: abiOf('GameEscrow'),
      functionName: 'createMatch',
      args: [parseEther(lobby.stake), lobby.seats],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  return holders;
}

/**
 * Stakes part of the LMS supply: the operator's own stake, enough to propose,
 * and some for each funded player so they can vote and earn from the first
 * match. The LMS comes from the treasury, sent as the timelock itself, which
 * anvil lets us impersonate; on a real deployment that is a grant proposal.
 */
async function stakeAsOperator(publicClient, lms, vault, timelock, holders) {
  const operator = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), transport: http(RPC) });
  const own = parseEther(OPERATOR_STAKE);
  const each = parseEther(PLAYER_STAKE);

  await rpc('anvil_impersonateAccount', [timelock]);
  await rpc('anvil_setBalance', [timelock, numberToHex(parseEther('1'))]);
  const asTimelock = createWalletClient({ account: timelock, transport: http(RPC) });
  const grant = await asTimelock.writeContract({
    chain: null,
    address: lms,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [operator.account.address, own + each * BigInt(holders.length)],
  });
  await publicClient.waitForTransactionReceipt({ hash: grant });
  await rpc('anvil_stopImpersonatingAccount', [timelock]);
  const calls = [
    [lms, erc20Abi, 'approve', [vault, own + each * BigInt(holders.length)]],
    [vault, abiOf('StakedLms'), 'deposit', [own]],
    // Deposited *for* each player: the shares, and the votes, are theirs.
    ...holders.map((holder) => [vault, abiOf('StakedLms'), 'depositFor', [holder, each]]),
  ];
  for (const [address, abi, functionName, args] of calls) {
    const hash = await operator.writeContract({ chain: null, address, abi, functionName, args });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

/**
 * Proposes raising the stakers' share of fees, so the governance screen has
 * something to vote on. The operator holds enough sLMS to clear the threshold.
 */
async function demoProposal(publicClient, governor, router) {
  // Voting power is read one second in the past, and the stake above may
  // share a timestamp with this transaction: step the clock first.
  await rpc('evm_increaseTime', [2]);
  await rpc('evm_mine', []);
  const operator = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), transport: http(RPC) });
  const hash = await operator.writeContract({
    chain: null,
    address: governor,
    abi: abiOf('LmsGovernor'),
    functionName: 'propose',
    args: [[router], [0n], [encodeFunctionData({ abi: abiOf('FeeRouter'), functionName: 'setStakerBps', args: [6_000] })], DEMO_PROPOSAL],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Plays the VRF node for the mock oracle.
 *
 * The mock never answers on its own — answering inside the request would reach
 * the escrow before it has recorded which match asked — so without this every
 * full lobby would sit `Pending` until it could only be cancelled.
 */
function runOracleNode(publicClient, oracle) {
  const node = createWalletClient({ account: ORACLE_NODE, transport: http(RPC) });
  const answered = new Set();
  publicClient.watchContractEvent({
    address: oracle,
    abi: abiOf('MockRandomnessOracle'),
    eventName: 'RandomnessRequested',
    pollingInterval: 1_000,
    onLogs: async (logs) => {
      for (const { args } of logs) {
        if (answered.has(args.requestId)) continue;
        answered.add(args.requestId);
        try {
          await node.writeContract({
            chain: null,
            address: oracle,
            abi: abiOf('MockRandomnessOracle'),
            functionName: 'fulfill',
            args: [args.requestId, toHex(randomBytes(32))],
          });
          log('oracle', `seeded match ${args.context.slice(0, 10)}…`);
        } catch (error) {
          log('oracle', `could not seed ${args.context.slice(0, 10)}…: ${error.shortMessage ?? error.message}`);
        }
      }
    },
    onError: (error) => log('oracle', `watch failed: ${error.shortMessage ?? error.message}`),
  });
}

function zapTokens() {
  return JSON.stringify(
    TOKENS.map(({ symbol, address, decimals, path }) => ({ symbol, address, decimals, path })),
  );
}

// -------------------------------------------------------------------- main

async function main() {
  await assertPortsFree();

  log('fork', 'Building the TypeScript packages the server runs from…');
  run('tsc --build', process.execPath, ['node_modules/typescript/bin/tsc', '--build']);

  log('fork', `Forking mainnet from ${FORK_RPC_URL}…`);
  start('anvil', 'anvil', [
    '--fork-url',
    FORK_RPC_URL,
    '--chain-id',
    String(CHAIN_ID),
    '--port',
    String(ANVIL_PORT),
    '--quiet',
  ]);
  const publicClient = createPublicClient({ transport: http(RPC) });
  await waitForAnvil(publicClient);

  log('fork', `Starting the spoke chain (${SPOKE_CHAIN_ID})…`);
  start('spoke', 'anvil', ['--chain-id', String(SPOKE_CHAIN_ID), '--port', String(SPOKE_PORT), '--quiet']);
  await waitForAnvil(createPublicClient({ transport: http(SPOKE_RPC) }), SPOKE_CHAIN_ID, SPOKE_RPC);

  log('fork', 'Deploying the protocol (compiles on first run)…');
  const addresses = deploy();
  log('fork', `GameEscrow ${addresses.GameEscrow} · ZapJoin ${addresses.ZapJoin}`);
  log('fork', `LMS ${addresses.LmsToken} · sLMS ${addresses.StakedLms} · FeeRouter ${addresses.FeeRouter}`);

  log('fork', 'Deploying the spoke…');
  const spoke = deploySpoke(addresses);
  log('fork', `SpokeRouter ${spoke.SpokeRouter} on ${SPOKE_CHAIN_ID} · hub receiver ${addresses.BridgeJoinReceiver}`);

  runOracleNode(publicClient, addresses.MockRandomnessOracle);
  runRelayer(addresses, spoke);

  log('fork', 'Funding players and opening lobbies…');
  const holders = await seed(publicClient, addresses.GameEscrow);
  await stakeAsOperator(publicClient, addresses.LmsToken, addresses.StakedLms, addresses.TimelockController, holders);
  await demoProposal(publicClient, addresses.LmsGovernor, addresses.FeeRouter);

  start('server', process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', '--clear-screen=false', 'packages/server/src/main.ts'], {
    tagged: false,
    env: {
      ...process.env,
      WS_PORT: String(SERVER_PORT),
      CHAIN_ID: String(CHAIN_ID),
      RPC_URL: RPC,
      ESCROW_ADDRESS: addresses.GameEscrow,
      ATTESTOR_PK: OPERATOR_KEY,
      KEEPER_PK: KEEPER_KEY,
      MATCHMAKER_PK: MATCHMAKER_KEY,
      // A short wait, so two browsers can make a table without finding two more.
      MATCHMAKING_FILL_AFTER_MS: '5000',
      ZAP_JOIN: addresses.ZapJoin,
      V4_QUOTER,
      ZAP_TOKENS: zapTokens(),
      // Harvest after every match, rather than waiting for the production
      // threshold a dev lobby's fees would never reach.
      FEE_ROUTER: addresses.FeeRouter,
      STAKED_LMS: addresses.StakedLms,
      REWARDS_DISTRIBUTOR: addresses.RewardsDistributor,
      GOVERNOR_ADDRESS: addresses.LmsGovernor,
      GOVERNOR_FROM_BLOCK: String(addresses.deployBlock),
      FEE_KEEPER_POLL_MS: '10000',
      HARVEST_MIN_WEI: '1',
      // Prompt-free logins: anvil's fork runs the latest hardfork, so EIP-7702 works.
      SESSION_DELEGATE: addresses.SessionKeyDelegate,
      SESSION_RELAYER_PK: SESSION_RELAYER_KEY,
      AVATAR_COLLECTIONS: JSON.stringify([
        { chainId: CHAIN_ID, address: addresses.PlayerAvatars, rpcUrl: RPC },
        { chainId: SPOKE_CHAIN_ID, address: spoke.PlayerAvatars, rpcUrl: SPOKE_RPC },
      ]),
      SPOKES: JSON.stringify([{ chainId: SPOKE_CHAIN_ID, router: spoke.SpokeRouter }]),
      CROSS_CHAIN_FROM_BLOCK: String(addresses.deployBlock),
    },
  });

  start(
    'client',
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'packages/client', '--port', String(CLIENT_PORT), '--strictPort', '--clearScreen', 'false'],
    {
      env: {
        ...process.env,
        VITE_WS_URL: `ws://localhost:${SERVER_PORT}`,
        VITE_RPC_URL: RPC,
        VITE_SPOKE_RPC_URL: SPOKE_RPC,
        VITE_DEV_KEY: PLAYER_KEY,
      },
    },
  );

  const funded = TOKENS.map((token) => `${formatUnits(parseUnits(TOKEN_FUNDING, token.decimals), token.decimals)} ${token.symbol}`);
  log('fork', '');
  log('fork', `\x1b[1mReady → http://localhost:${CLIENT_PORT}\x1b[0m`);
  log('fork', `Lobbies: ${LOBBIES.map((l) => `${l.stake} ETH × ${l.seats}`).join(', ')} · pay with ETH, ${TOKENS.map((t) => t.symbol).join(', ')}`);
  log('fork', `Funded with ${funded.join(', ')}: ${holders.join(', ')}`);
  log('fork', 'No wallet extension: the page signs with the funded dev burner automatically.');
  log('fork', `Stake from the spoke: http://localhost:${CLIENT_PORT}/?chain=spoke puts the burner on ${SPOKE_CHAIN_ID}.`);
  log('fork', `With one: add network RPC ${RPC}, chain id ${CHAIN_ID}, and rerun with FORK_PLAYER=<your address>.`);
  log('fork', `The spoke is RPC ${SPOKE_RPC}, chain id ${SPOKE_CHAIN_ID}; joins are filled on the hub ${FILL_DELAY_MS / 1000}s after they are sent.`);
  log('fork', 'Ctrl+C stops everything.');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
