#!/usr/bin/env node
/**
 * `npm run testnet -- <command>` — gets the Base Sepolia + Arbitrum Sepolia
 * deployment ready to be played from 4, 6 or 8 accounts.
 *
 *   accounts [--count 8] [--force]   generates player keys into .testnet-accounts.json (gitignored)
 *   fund [--hub 0.01] [--spoke 0.005] [--spoke-players 1-2] [--roles 0.02] [--yes]
 *                                    tops every player up to --hub / --spoke ETH, and the
 *                                    server's keeper, matchmaker and relayer keys to --roles
 *                                    on Base Sepolia, from FUNDER_PK (default DEPLOYER_PK).
 *                                    Prints the plan; sends only with --yes.
 *   doctor                           checks everything a staked match needs, and says what is missing
 *   up [--commit-ms 60000] [--db] [--client-only --ws wss://…]
 *                                    runs the game server and a dev client against testnet,
 *                                    with one burner per tab: http://localhost:5173/?player=N
 *
 * Then play with `npm run play -- <command> --net testnet`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { protocolConfigAbi } from '@lms/contracts';

import { TESTNET, TESTNET_ACCOUNTS, loadProfile, readDotEnv, testnetPlayers } from './lib/profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? 'help';

const chain = (id, name, rpc) => ({ id, name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

/** Base Sepolia tokens to offer for paying a stake, if the v4 quoter can price them. */
const ZAP_CANDIDATES = [
  {
    symbol: 'USDC',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    paths: [
      [{ intermediateCurrency: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', fee: 500, tickSpacing: 10 }],
      [{ intermediateCurrency: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', fee: 3000, tickSpacing: 60 }],
      [{ intermediateCurrency: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', fee: 10000, tickSpacing: 200 }],
    ],
  },
];
const quoterAbi = parseAbi([
  'struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }',
  'struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }',
  'function quoteExactOutput(QuoteExactParams params) returns (uint256 amountIn, uint256 gasEstimate)',
]);
const coordinatorAbi = parseAbi([
  'function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)',
]);

// ----------------------------------------------------------------- accounts

function accounts() {
  if (existsSync(TESTNET_ACCOUNTS) && !flags.force) {
    console.log('.testnet-accounts.json already exists (pass --force to replace it, which strands any ETH on the old keys):');
  } else {
    const count = Number(flags.count ?? 8);
    const keys = Array.from({ length: count }, () => ({ key: generatePrivateKey() }));
    writeFileSync(TESTNET_ACCOUNTS, `${JSON.stringify({ note: 'Testnet player keys for npm run play. Never fund with real ETH.', players: keys }, null, 2)}\n`);
    console.log(`Wrote ${count} keys to .testnet-accounts.json (gitignored):`);
  }
  for (const p of testnetPlayers()) console.log(`  P${p.n}  ${p.address}`);
  console.log('\nNext: npm run testnet -- fund');
}

// --------------------------------------------------------------------- fund

/** `2-4` or `1,3,5` as a set of numbers. */
function numbers(spec) {
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let n = a; n <= (b || a); n++) set.add(n);
  }
  return set;
}

async function fund() {
  const profile = loadProfile('testnet');
  const env = profile.env;
  const funderKey = env.FUNDER_PK || env.DEPLOYER_PK;
  if (!/^0x[0-9a-fA-F]{64}$/.test(funderKey ?? '')) throw new Error('Set FUNDER_PK (or DEPLOYER_PK) in .env: the account that pays.');
  const players = testnetPlayers();
  if (players.length === 0) throw new Error('No players: run `npm run testnet -- accounts` first.');

  const funder = privateKeyToAccount(funderKey);
  const targets = { hub: parseEther(String(flags.hub ?? '0.01')), spoke: parseEther(String(flags.spoke ?? '0.005')), roles: parseEther(String(flags.roles ?? '0.02')) };
  const sides = [
    { side: 'hub', ...profile.hub },
    ...(profile.spoke ? [{ side: 'spoke', ...profile.spoke }] : []),
  ];

  const plan = [];
  for (const { side, chainId, name, rpc } of sides) {
    const client = createPublicClient({ transport: http(rpc) });
    const only = side === 'spoke' && flags['spoke-players'] ? numbers(flags['spoke-players']) : null;
    const recipients = players.filter((p) => !only || only.has(p.n)).map((p) => ({ label: `P${p.n}`, address: p.address, target: targets[side] }));
    if (side === 'hub') {
      for (const role of ['keeper', 'matchmaker', 'sessionRelayer']) {
        const r = profile.roles[role];
        if (r) recipients.push({ label: role, address: r.address, target: targets.roles });
      }
    }
    for (const recipient of recipients) {
      const balance = await client.getBalance({ address: recipient.address });
      if (balance < recipient.target) plan.push({ side, chainId, name, rpc, ...recipient, balance, amount: recipient.target - balance });
    }
  }

  if (plan.length === 0) return console.log('Everyone already has at least the target. Nothing to send.');
  console.log(`From ${funder.address}:`);
  for (const step of plan) console.log(`  ${step.name.padEnd(17)} ${step.label.padEnd(15)} ${step.address}  ${formatEther(step.balance)} → +${formatEther(step.amount)} ETH`);
  for (const { side, name, rpc } of sides) {
    const total = plan.filter((s) => s.side === side).reduce((sum, s) => sum + s.amount, 0n);
    const have = await createPublicClient({ transport: http(rpc) }).getBalance({ address: funder.address });
    console.log(`  ${name}: sends ${formatEther(total)} ETH, funder holds ${formatEther(have)}${have < total ? '  ← NOT ENOUGH' : ''}`);
  }
  if (!flags.yes) return console.log('\nNothing sent. Rerun with --yes to send these transactions.');

  for (const step of plan) {
    const wallet = createWalletClient({ account: funder, chain: chain(step.chainId, step.name, step.rpc), transport: http(step.rpc) });
    const hash = await wallet.sendTransaction({ to: step.address, value: step.amount });
    await createPublicClient({ transport: http(step.rpc) }).waitForTransactionReceipt({ hash });
    console.log(`  sent ${formatEther(step.amount)} ETH to ${step.label} on ${step.name}: ${hash}`);
  }
}

// ------------------------------------------------------------------- doctor

async function doctor() {
  const profile = loadProfile('testnet');
  const env = profile.env;
  const C = profile.contracts;
  const hub = createPublicClient({ transport: http(profile.hub.rpc) });
  let problems = 0;
  const ok = (line) => console.log(`  ok    ${line}`);
  const bad = (line) => {
    problems++;
    console.log(`  FIX   ${line}`);
  };
  const warn = (line) => console.log(`  note  ${line}`);

  console.log('Chains');
  for (const [side, expected] of [
    ['hub', TESTNET.hubChainId],
    ['spoke', TESTNET.spokeChainId],
  ]) {
    const config = profile[side];
    if (!config) {
      warn(`no ${side} registry: cross-chain joins are off`);
      continue;
    }
    try {
      const id = await createPublicClient({ transport: http(config.rpc) }).getChainId();
      if (id === expected) ok(`${config.name} RPC answers (${id})`);
      else bad(`${config.name} RPC is chain ${id}, not ${expected}`);
    } catch (error) {
      bad(`${config.name} RPC unreachable: ${error.shortMessage ?? error.message}`);
    }
  }
  try {
    const head = await hub.getBlockNumber();
    await hub.getLogs({ address: C.escrow, fromBlock: head - 9_999n, toBlock: head });
    ok('hub RPC serves 10,000-block log ranges (the server scans that much)');
  } catch {
    bad('hub RPC refuses a 10,000-block eth_getLogs: set RPC_URL to one that allows it (not Alchemy free tier)');
  }

  console.log('Contracts and roles');
  const code = await hub.getCode({ address: C.escrow });
  if (code && code !== '0x') ok(`GameEscrow at ${C.escrow}`);
  else bad(`no code at the registry's escrow ${C.escrow}`);
  const read = (functionName, args = []) => hub.readContract({ address: C.config, abi: protocolConfigAbi, functionName, args });
  try {
    const matchmaker = await read('matchmaker');
    const mine = profile.roles.matchmaker?.address;
    if (mine && matchmaker.toLowerCase() === mine.toLowerCase()) ok(`matchmaker is MATCHMAKER_PK's address`);
    else bad(`config.matchmaker() is ${matchmaker}, MATCHMAKER_PK is ${mine ?? 'unset'}: no matchmade lobbies`);
  } catch (error) {
    warn(`could not read the matchmaker: ${error.shortMessage ?? error.message}`);
  }
  try {
    const attestor = profile.roles.attestor?.address;
    const isAttestor = attestor ? await read('isAttestor', [attestor]) : false;
    const threshold = await read('attestorThreshold');
    if (isAttestor && Number(threshold) === 1) ok('ATTESTOR_PK is an attestor and the threshold is 1');
    else bad(`ATTESTOR_PK attestor: ${isAttestor}, threshold ${threshold}: settle will fail (QuorumNotMet)`);
  } catch (error) {
    warn(`could not read the attestor set: ${error.shortMessage ?? error.message}`);
  }
  for (const role of ['attestor', 'keeper', 'matchmaker', 'sessionRelayer']) {
    if (!profile.roles[role]) bad(`${role.toUpperCase()}_PK unset in .env`);
  }
  for (const role of ['keeper', 'matchmaker', 'sessionRelayer']) {
    const r = profile.roles[role];
    if (!r) continue;
    const balance = await hub.getBalance({ address: r.address });
    if (balance >= parseEther('0.005')) ok(`${role} holds ${formatEther(balance)} ETH`);
    else bad(`${role} ${r.address} holds ${formatEther(balance)} ETH: fund it (npm run testnet -- fund)`);
  }

  console.log('Randomness');
  if (!profile.vrf.subId) bad('VRF_SUBSCRIPTION_ID unset in .env: cannot check the subscription');
  else {
    try {
      const [, nativeBalance, reqCount, owner, consumers] = await hub.readContract({ address: TESTNET.vrfCoordinator, abi: coordinatorAbi, functionName: 'getSubscription', args: [BigInt(profile.vrf.subId)] });
      if (consumers.some((c) => c.toLowerCase() === C.randomnessOracle.toLowerCase())) ok(`the VRF adapter is a consumer (${reqCount} requests so far)`);
      else bad(`the VRF adapter ${C.randomnessOracle} is not a consumer: as the Safe, Add Consumer at vrf.chain.link`);
      if (nativeBalance >= parseEther('0.02')) ok(`subscription holds ${formatEther(nativeBalance)} ETH`);
      else bad(`subscription holds ${formatEther(nativeBalance)} ETH: fund it with native ETH (keep ≥ 0.05 on the 30 gwei lane)`);
      if (profile.roles.safe && owner.toLowerCase() !== profile.roles.safe.address.toLowerCase()) warn(`subscription owner ${owner} is not SAFE`);
    } catch (error) {
      bad(`could not read the subscription: ${error.shortMessage ?? error.message}`);
    }
  }

  console.log('Players');
  const players = testnetPlayers();
  if (players.length === 0) bad('no players: npm run testnet -- accounts');
  const spokeClient = profile.spoke && createPublicClient({ transport: http(profile.spoke.rpc) });
  for (const p of players) {
    const [h, s] = await Promise.all([hub.getBalance({ address: p.address }), spokeClient ? spokeClient.getBalance({ address: p.address }) : 0n]);
    const line = `P${p.n} ${p.address}  ${formatEther(h)} ETH hub · ${formatEther(s)} ETH spoke`;
    if (h >= parseEther('0.003')) ok(line);
    else bad(`${line}: fund it (npm run testnet -- fund)`);
  }

  console.log('Optional features');
  const zap = await liveZapTokens(hub);
  if (C.zapJoin && zap.length) ok(`token joins: ${zap.map((t) => t.symbol).join(', ')}`);
  else warn('no v4 route prices on Base Sepolia right now: token joins are off (try them on the fork)');
  try {
    const discount = await read('lmsPerEthDiscount');
    if (discount > 0n) ok('LMS fee discount on');
    else warn('LMS fee discount off');
  } catch {
    // Older config.
  }
  warn('governance, vesting and unstaking need days of real time on testnet: test them on the fork');

  console.log('Server');
  try {
    const health = await fetch(profile.ws.replace(/^ws/, 'http') + '/health').then((r) => r.json());
    if (health.onChain) ok(`${profile.ws} is up and on-chain`);
    else bad(`${profile.ws} is up but not on-chain: is RPC_URL set?`);
  } catch {
    warn(`${profile.ws} not reachable (start it with npm run testnet -- up)`);
  }
  console.log(problems ? `\n${problems} thing(s) to fix.` : '\nReady.');
}

async function liveZapTokens(hub) {
  const tokens = [];
  for (const candidate of ZAP_CANDIDATES) {
    for (const hops of candidate.paths) {
      const path = hops.map((hop) => ({ ...hop, hooks: zeroAddress, hookData: '0x' }));
      try {
        await hub.simulateContract({ address: TESTNET.v4Quoter, abi: quoterAbi, functionName: 'quoteExactOutput', args: [{ exactCurrency: zeroAddress, path, exactAmount: parseEther('0.001') }] });
        tokens.push({ symbol: candidate.symbol, address: candidate.address, decimals: candidate.decimals, path: hops });
        break;
      } catch {
        // Not this route.
      }
    }
  }
  return tokens;
}

// ----------------------------------------------------------------------- up

function start(tag, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[${tag}] exited (${code})`);
    process.exit(code ?? 1);
  });
  return child;
}

async function up() {
  const profile = loadProfile('testnet');
  const env = readDotEnv();
  const C = profile.contracts;
  const S = profile.spokeContracts;
  const players = testnetPlayers();
  const wsPort = Number(env.WS_PORT || 8787);
  const ws = flags.ws ?? `ws://localhost:${wsPort}`;
  const children = [];

  if (!flags['client-only']) {
    const hub = createPublicClient({ transport: http(profile.hub.rpc) });
    const zap = C.zapJoin ? await liveZapTokens(hub) : [];
    const serverEnv = {
      ...env,
      CHAIN_ID: String(TESTNET.hubChainId),
      COMMIT_MS: String(flags['commit-ms'] ?? 60000),
      REVEAL_MS: String(flags['reveal-ms'] ?? 15000),
      // Local play: in memory, unless --db, so a hosted server on the same
      // database keeps its lock and its archive to itself.
      ...(flags.db ? {} : { DATABASE_URL: '', ARCHIVE: 'memory' }),
      NODE_ENV: 'development',
      MATCHMAKING_TIERS:
        env.MATCHMAKING_TIERS ||
        JSON.stringify([4, 6, 8].map((seats) => ({ stake: parseEther('0.001').toString(), seats }))),
      MATCHMAKING_FILL_AFTER_MS: env.MATCHMAKING_FILL_AFTER_MS || '15000',
      GATEWAY_LIMITS: env.GATEWAY_LIMITS || JSON.stringify({ connectRatePerIp: 50, connectBurstPerIp: 100, loginRatePerIp: 50, loginBurstPerIp: 100 }),
      SPOKES: env.SPOKES || (S.spokeRouter ? JSON.stringify([{ chainId: TESTNET.spokeChainId, router: S.spokeRouter }]) : ''),
      AVATAR_COLLECTIONS:
        env.AVATAR_COLLECTIONS ||
        JSON.stringify([
          ...(C.avatars ? [{ chainId: TESTNET.hubChainId, address: C.avatars, rpcUrl: profile.hub.rpc }] : []),
          ...(S.avatars && profile.spoke ? [{ chainId: TESTNET.spokeChainId, address: S.avatars, rpcUrl: profile.spoke.rpc }] : []),
        ]),
      FEE_ROUTER: env.FEE_ROUTER || C.feeRouter || '',
      ...(zap.length && !env.ZAP_TOKENS ? { V4_QUOTER: TESTNET.v4Quoter, ZAP_TOKENS: JSON.stringify(zap) } : {}),
    };
    if (!zap.length && !env.ZAP_TOKENS) {
      // ZAP_JOIN comes from the registry; without a priced route the server offers ETH only.
      serverEnv.ZAP_JOIN = '';
      serverEnv.V4_QUOTER = '';
      serverEnv.ZAP_TOKENS = '';
    }
    console.log(`[testnet] server on :${wsPort} against ${profile.hub.name}${flags.db ? ' (archiving to DATABASE_URL)' : ' (archive in memory)'}, commit ${serverEnv.COMMIT_MS} ms`);
    children.push(start('server', ['node_modules/tsx/dist/cli.mjs', 'watch', '--clear-screen=false', 'packages/server/src/main.ts'], serverEnv));
  }

  const clientPort = Number(flags['client-port'] ?? 5173);
  children.push(
    start('client', ['node_modules/vite/bin/vite.js', 'packages/client', '--port', String(clientPort), '--strictPort', '--clearScreen', 'false'], {
      ...process.env,
      VITE_WS_URL: ws,
      VITE_RPC_URL: profile.hub.rpc,
      VITE_SPOKE_RPC_URL: profile.spoke?.rpc ?? '',
      VITE_ACROSS_API: profile.across.api,
      VITE_DEV_KEY: players[0]?.key ?? '',
      VITE_DEV_KEYS: players.map((p) => p.key).join(','),
    }),
  );
  console.log(`[testnet] client: http://localhost:${clientPort}/?player=1 … /?player=${players.length || 8}  (&chain=spoke to stake from ${profile.spoke?.name ?? 'the spoke'})`);
  const stop = () => {
    for (const child of children) {
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// --------------------------------------------------------------------- main

const COMMANDS = { accounts, fund, doctor, up };
if (!COMMANDS[command]) {
  console.log(`npm run testnet -- accounts | fund | doctor | up   (see the top of scripts/testnet.mjs)`);
  process.exit(command === 'help' ? 0 : 1);
}
try {
  await COMMANDS[command]();
} catch (error) {
  console.error(error.shortMessage ?? error.message);
  process.exit(1);
}
