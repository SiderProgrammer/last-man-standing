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
 *      the real v4 `PoolManager` and a seeded LMS/ETH pool for fee buybacks,
 *   4. plays the randomness oracle: every `lockMatch` gets its seed a block
 *      later, as it would from Chainlink VRF,
 *   5. funds the browser's dev burner (and `FORK_PLAYER`, if set) with USDC,
 *      USDT and DAI, and opens two lobbies,
 *   6. starts the server and the client wired to all of it.
 *
 * Ctrl+C stops everything. Nothing is written outside `contracts/broadcast/`,
 * which is gitignored, and no `.env` is read or written.
 *
 * Environment (all optional):
 *   FORK_RPC_URL      mainnet RPC to fork     default: https://ethereum-rpc.publicnode.com
 *   FORK_PLAYER       an address to fund too, e.g. your wallet extension's account
 *   FORK_ANVIL_PORT   default 8545
 *   FORK_SERVER_PORT  default 8788, so it does not collide with a normal `npm run dev` on 8787
 *   FORK_CLIENT_PORT  default 5174, likewise beside 5173
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = fileURLToPath(new URL('../contracts/', import.meta.url));

const FORK_RPC_URL = process.env.FORK_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const ANVIL_PORT = Number(process.env.FORK_ANVIL_PORT || 8545);
const SERVER_PORT = Number(process.env.FORK_SERVER_PORT || 8788);
const CLIENT_PORT = Number(process.env.FORK_CLIENT_PORT || 5174);
const EXTRA_PLAYER = process.env.FORK_PLAYER || '';

const CHAIN_ID = 31337;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil's first two default accounts, from its public test mnemonic. They are
// funded on every anvil node and worthless anywhere else.
/** Deploys, attests results, pays for `lockMatch`, and creates the seed lobbies. */
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** The browser's dev burner, used when no wallet extension is installed. */
const PLAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

/**
 * Answers the mock oracle. A different anvil dev account from the operator,
 * which the server also signs with, so the two never race for a nonce; and an
 * unlocked one, so anvil signs for it and no key is needed here.
 */
const ORACLE_NODE = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';

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

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const vaultAbi = parseAbi(['function deposit(uint256 assets, address receiver) returns (uint256)']);
/** Staked by the operator, so fee buybacks have someone to buy for. See `FeeKeeperPolicy.maxLockedShareBps`. */
const OPERATOR_STAKE = '10000';
/** Airdropped to each funded player, so the claim flow can be tried at once. */
const DEV_AIRDROP_LMS = '250';
const lmsTransferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const escrowAbi = parseAbi(['function createMatch(uint128 stake, uint16 maxSeats) returns (bytes32)']);
const oracleAbi = parseAbi([
  'event RandomnessRequested(bytes32 indexed requestId, address indexed consumer, bytes32 context)',
  'function fulfill(bytes32 requestId, bytes32 randomness)',
]);

const children = [];
let stopping = false;

// ------------------------------------------------------------------ output

const COLORS = { anvil: 90, server: 36, client: 35, fork: 32, oracle: 33 };

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

async function waitForAnvil(publicClient) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await publicClient.getChainId()) === CHAIN_ID) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`anvil did not come up on ${RPC} within 60 s. Is ${FORK_RPC_URL} reachable?`);
}

function deploy() {
  // The deploy script reads these; a value left in the shell must not leak in.
  const env = { ...process.env, DEPLOYER_PK: OPERATOR_KEY, POOL_MANAGER };
  const deployKeys = [
    ...['SAFE', 'TREASURY', 'ATTESTOR', 'ATTESTORS', 'ATTESTOR_THRESHOLD', 'TIMELOCK_DELAY'],
    ...['LMS_SUPPLY', 'STAKE_COOLDOWN', 'VOTING_DELAY', 'VOTING_PERIOD', 'PROPOSAL_THRESHOLD', 'QUORUM_PERCENT'],
    ...['KEEPER', 'STAKER_FEE_BPS', 'LMS_POOL_FEE', 'LMS_POOL_TICK_SPACING', 'LIQUIDITY_ETH', 'LIQUIDITY_LMS'],
  ];
  for (const key of deployKeys) {
    delete env[key];
  }
  // The operator runs the fee keeper too, and seeds the LMS/ETH pool at
  // 100,000 LMS per ETH so buybacks work from the first settled match.
  env.KEEPER = privateKeyToAccount(OPERATOR_KEY).address;
  env.LIQUIDITY_ETH = parseEther('10').toString();
  env.LIQUIDITY_LMS = parseEther('1000000').toString();
  run('forge script', 'forge', ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', RPC, '--broadcast'], {
    cwd: CONTRACTS,
    env,
  });

  const broadcast = JSON.parse(
    readFileSync(new URL(`../contracts/broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json`, import.meta.url), 'utf8'),
  );
  const addresses = {};
  for (const tx of broadcast.transactions) {
    if (tx.transactionType === 'CREATE') addresses[tx.contractName] = tx.contractAddress;
  }
  if (!addresses.GameEscrow || !addresses.ZapJoin || !addresses.MockRandomnessOracle || !addresses.FeeRouter) {
    fail('Deploy did not produce a GameEscrow, a ZapJoin, a MockRandomnessOracle and a FeeRouter.');
  }
  return addresses;
}

async function rpc(method, params) {
  const response = await fetch(RPC, {
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
    abi: erc20,
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
  if (EXTRA_PLAYER) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(EXTRA_PLAYER)) fail(`FORK_PLAYER is not an address: ${EXTRA_PLAYER}`);
    holders.push(EXTRA_PLAYER);
    await rpc('anvil_setBalance', [EXTRA_PLAYER, numberToHex(parseEther('100'))]);
  }
  for (const holder of holders) {
    for (const token of TOKENS) await fundToken(publicClient, token, holder);
  }

  const operator = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), transport: http(RPC) });
  for (const lobby of LOBBIES) {
    const hash = await operator.writeContract({
      chain: null,
      address: escrow,
      abi: escrowAbi,
      functionName: 'createMatch',
      args: [parseEther(lobby.stake), lobby.seats],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  return holders;
}

/**
 * Stakes some of the LMS supply as the operator. With no `SAFE` on a local
 * node the operator *is* the Safe and holds the supply. Without stakers the
 * fee keeper holds buybacks back, because they would only enrich the vault's
 * locked seed.
 */
/**
 * A dev airdrop for the funded players, so the claim flow works the moment the
 * page opens. A real one comes from `npm run airdrop`, which needs a history
 * of settled matches that a fresh fork does not have.
 */
async function devAirdrop(publicClient, addresses, holders) {
  const { buildAirdrop } = await import('@lms/protocol');
  const airdrop = buildAirdrop(new Map(holders.map((holder) => [holder, parseEther(DEV_AIRDROP_LMS)])));
  const operator = privateKeyToAccount(OPERATOR_KEY).address;

  const env = {
    ...process.env,
    DEPLOYER_PK: OPERATOR_KEY,
    LMS: addresses.LmsToken,
    STAKED_LMS: addresses.StakedLms,
    AIRDROP_ROOT: airdrop.root,
    AIRDROP_TREASURY: operator,
  };
  delete env.AIRDROP_CLAIM_DAYS;
  run('forge script', 'forge', ['script', 'script/Airdrop.s.sol:DeployAirdrop', '--rpc-url', RPC, '--broadcast'], {
    cwd: CONTRACTS,
    env,
  });
  const broadcast = JSON.parse(
    readFileSync(new URL(`../contracts/broadcast/Airdrop.s.sol/${CHAIN_ID}/run-latest.json`, import.meta.url), 'utf8'),
  );
  const address = broadcast.transactions.find((tx) => tx.contractName === 'LmsAirdrop')?.contractAddress;
  if (!address) fail('The airdrop script did not deploy an LmsAirdrop.');

  const wallet = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), transport: http(RPC) });
  const hash = await wallet.writeContract({
    chain: null,
    address: addresses.LmsToken,
    abi: lmsTransferAbi,
    functionName: 'transfer',
    args: [address, airdrop.total],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  // Inside `contracts/broadcast/`, which is gitignored like the rest of a run's output.
  const file = fileURLToPath(new URL('../contracts/broadcast/dev-airdrop.json', import.meta.url));
  writeFileSync(file, JSON.stringify(airdrop, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
  return { address, file };
}

async function stakeAsOperator(publicClient, lms, vault) {
  const operator = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), transport: http(RPC) });
  const amount = parseEther(OPERATOR_STAKE);
  for (const [address, abi, functionName, args] of [
    [lms, erc20, 'approve', [vault, amount]],
    [vault, vaultAbi, 'deposit', [amount, operator.account.address]],
  ]) {
    const hash = await operator.writeContract({ chain: null, address, abi, functionName, args });
    await publicClient.waitForTransactionReceipt({ hash });
  }
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
    abi: oracleAbi,
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
            abi: oracleAbi,
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

  log('fork', 'Deploying the protocol (compiles on first run)…');
  const addresses = deploy();
  log('fork', `GameEscrow ${addresses.GameEscrow} · ZapJoin ${addresses.ZapJoin}`);
  log('fork', `LMS ${addresses.LmsToken} · sLMS ${addresses.StakedLms} · FeeRouter ${addresses.FeeRouter}`);

  runOracleNode(publicClient, addresses.MockRandomnessOracle);

  log('fork', 'Funding players and opening lobbies…');
  const holders = await seed(publicClient, addresses.GameEscrow);
  await stakeAsOperator(publicClient, addresses.LmsToken, addresses.StakedLms);
  const airdrop = await devAirdrop(publicClient, addresses, holders);

  start('server', process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', '--clear-screen=false', 'packages/server/src/main.ts'], {
    tagged: false,
    env: {
      ...process.env,
      WS_PORT: String(SERVER_PORT),
      CHAIN_ID: String(CHAIN_ID),
      RPC_URL: RPC,
      ESCROW_ADDRESS: addresses.GameEscrow,
      ATTESTOR_PK: OPERATOR_KEY,
      KEEPER_PK: OPERATOR_KEY,
      ZAP_JOIN: addresses.ZapJoin,
      V4_QUOTER,
      ZAP_TOKENS: zapTokens(),
      // Harvest and buy back after every match, rather than waiting for the
      // production thresholds a dev lobby's fees would never reach.
      FEE_ROUTER: addresses.FeeRouter,
      STAKED_LMS: addresses.StakedLms,
      AIRDROP_ADDRESS: airdrop.address,
      AIRDROP_FILE: airdrop.file,
      FEE_KEEPER_POLL_MS: '10000',
      HARVEST_MIN_WEI: '1',
      BUYBACK_MIN_WEI: '1',
      // One-click play: anvil's fork runs the latest hardfork, so EIP-7702 works.
      SESSION_DELEGATE: addresses.SessionKeyDelegate,
      AVATAR_COLLECTIONS: JSON.stringify([
        { chainId: CHAIN_ID, address: addresses.PlayerAvatars, rpcUrl: RPC },
      ]),
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
  log('fork', `With one: add network RPC ${RPC}, chain id ${CHAIN_ID}, and rerun with FORK_PLAYER=<your address>.`);
  log('fork', 'Ctrl+C stops everything.');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
