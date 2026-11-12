#!/usr/bin/env node
/**
 * `npm run play -- <command>` — drives up to eight player accounts against a
 * running stack, so a 4-, 6- or 8-seat match can be played by one person:
 * some seats by hand in browser tabs (`?player=N`), the rest by bots that
 * speak the real wire protocol and stake real (test) ETH.
 *
 *   --net fork      the stack `npm run fork:base` runs (default)
 *   --net testnet   Base Sepolia + Arbitrum Sepolia, with the server from
 *                   `npm run testnet -- up`; players from `npm run testnet -- accounts`
 *
 * `npm run play -- help` lists the commands. docs/PLAYTEST.md walks through
 * every feature with them.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  toHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  gameEscrowAbi,
  lmsGovernorAbi,
  spokeRouterAbi,
  feeRouterAbi,
  rewardsDistributorAbi,
  rewardVestingAbi,
  zapJoinAbi,
  v4QuoterAbi,
  maxAmountInFor,
  quoteAcross,
  localQuote,
  joinMessage,
  ZAP_DEADLINE_SECONDS,
} from '@lms/contracts';
import { BotClient, wsLink } from '@lms/harness';

import { loadProfile } from './lib/profile.mjs';

const STATUS = ['None', 'Open', 'Pending', 'Live', 'Proposed', 'Settled', 'Cancelled'];
const SEARCH_BLOCKS = 9_000n;

// ---------------------------------------------------------------- arguments

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
const net = flags.net ?? process.env.PLAY_NET ?? 'fork';

const HELP = `npm run play -- <command> [--net fork|testnet]

Accounts and lobbies
  info                                   chains, contracts, roles, server
  accounts                               every player: ETH on both chains, escrow balance, LMS, sLMS
  lobbies [--last 10]                    the newest lobbies and their state
  status <match>                         one lobby: seats, origins, result, balances

Seating and playing (match = 0x… id, #nonce, or "last")
  create --stake 0.001 --seats 4 [--as 1]                     open a private lobby
  join <match> --players 2-4 [--from spoke] [--token USDC] [--lms 1000]
  bots <match> --players 2-4 [--hold] [--think 500-3000]      seated players play it out
  fill <match> --players 2-4 [join and bots options]          join, then play
  table --seats 6 --humans 2 [--stake 0.001]                  lobby by P1, bots in seats humans+1…, you join P1…Phumans in tabs
  queue --stake 0.001 --seats 4 --players 2-4 [--from spoke]  bots matchmake, stake, play

Lifecycle by hand
  lock <match> [--as N]   cancel <match> [--as N]   finalize <match> [--as N]
  dispute <match> --as N  veto <match>   dismiss <match>   pause        (guardian: fork, or GUARDIAN_PK on testnet)
  withdraw --players 1-8

Governance (fork; needs staked LMS)
  gov propose --bps 6000 [--as 1] [--salt x]   a proposal setting the stakers' share of fees
  gov vote <id> --players 1-4 [--support for|against|abstain]
  gov state <id>          gov queue --bps 6000 [--salt x]          gov execute --bps 6000 [--salt x]

Play-mining (matchmade lobbies only)
  rewards [--players all] [--claim] [--release]   LMS earned per ended week, claimed into vesting, released as it vests

Time (fork only)
  warp <90s|10m|1h|2d|epoch>             moves both forks' clocks; "epoch" = past the next play-mining week

Players: --players 2-4 | 1,3,5 | all.  --as N acts as player N.`;

// -------------------------------------------------------------- the network

let profile;
try {
  profile = command === 'help' ? null : loadProfile(net);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const hubChain = profile && chainOf(profile.hub);
const spokeChain = profile?.spoke && chainOf(profile.spoke);
const hub = profile && createPublicClient({ chain: hubChain, transport: http(profile.hub.rpc) });
const spoke = profile?.spoke && createPublicClient({ chain: spokeChain, transport: http(profile.spoke.rpc) });
const C = profile?.contracts ?? {};

function chainOf({ chainId, name, rpc }) {
  return { id: chainId, name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
}

function walletOn(which, key) {
  const [chain, url] = which === 'spoke' ? [spokeChain, profile.spoke.rpc] : [hubChain, profile.hub.rpc];
  return createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(url) });
}

const short = (hex) => `${hex.slice(0, 8)}…${hex.slice(-4)}`;
const eth = (wei) => `${Number(formatEther(wei)).toFixed(5)}`;
/** viem's summary, plus the contract's custom error by name when it decoded one. */
function reason(error) {
  const text = error?.shortMessage ?? error?.message ?? String(error);
  const data = error?.walk?.((e) => e?.data?.errorName !== undefined)?.data;
  const raw = error?.walk?.((e) => typeof e?.signature === 'string')?.signature;
  if (data?.errorName) return `${text.replace(/\.$/, '')}: ${data.errorName}${data.args?.length ? `(${data.args.map(String).join(', ')})` : ''}`;
  if (raw) return `${text} (error selector ${raw})`;
  return text;
}

/** Simulates, sends, waits. Returns the receipt; throws with the revert reason. */
async function send(which, key, request, label) {
  const client = which === 'spoke' ? spoke : hub;
  const wallet = walletOn(which, key);
  const { request: prepared } = await client.simulateContract({ account: wallet.account, ...request });
  const hash = await wallet.writeContract(prepared);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label ?? request.functionName} reverted: ${hash}`);
  if (label) console.log(`  ${label}  tx ${short(hash)}`);
  return receipt;
}

function players(spec) {
  const all = profile.players;
  if (all.length === 0) throw new Error(net === 'testnet' ? 'No players yet: run `npm run testnet -- accounts` first.' : 'The fork profile has no players.');
  if (!spec || spec === true || spec === 'all') return all;
  const wanted = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let n = a; n <= (b || a); n++) wanted.add(n);
  }
  const chosen = all.filter((p) => wanted.has(p.n));
  if (chosen.length !== wanted.size) throw new Error(`Only players 1-${all.length} exist.`);
  return chosen;
}

const player = (n) => players(String(n ?? 1))[0];

/** A role's key, or an explanation of where to put it. */
function roleKey(role) {
  const entry = profile.roles?.[role];
  if (entry?.key) return entry.key;
  throw new Error(`No key for the ${role}${net === 'testnet' ? `: set ${role.toUpperCase()}_PK in .env to act as it from here, or use its wallet` : ''}.`);
}

function matchIdOf(nonce) {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [BigInt(profile.hub.chainId), C.escrow, BigInt(nonce)]));
}

async function matchNonce() {
  return hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'matchNonce' });
}

async function resolveMatch(ref) {
  if (!ref) throw new Error('Which match? Pass its id, #nonce, or "last".');
  if (/^0x[0-9a-fA-F]{64}$/.test(ref)) return ref;
  if (ref === 'last' || ref === 'latest') {
    const nonce = await matchNonce();
    if (nonce === 0n) throw new Error('No lobby has been opened yet.');
    return matchIdOf(nonce - 1n);
  }
  if (/^#?\d+$/.test(ref)) return matchIdOf(ref.replace('#', ''));
  throw new Error(`Not a match: ${ref}`);
}

const getMatch = (id) => hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'getMatch', args: [id] });

function parseDuration(text) {
  const match = /^(\d+)(s|m|h|d|w)?$/.exec(String(text));
  if (!match) throw new Error(`Not a duration: ${text} (try 90s, 10m, 1h, 2d)`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2] ?? 's'];
}

// ------------------------------------------------------------------- reads

async function info() {
  console.log(`${profile.net}: hub ${profile.hub.name} (${profile.hub.chainId}) ${profile.hub.rpc}`);
  if (profile.spoke) console.log(`       spoke ${profile.spoke.name} (${profile.spoke.chainId}) ${profile.spoke.rpc}`);
  console.log(`server ${profile.ws}   client ${profile.client}/?player=1`);
  console.log('\nhub contracts');
  for (const [name, address] of Object.entries(C)) console.log(`  ${name.padEnd(20)} ${address}`);
  if (profile.spoke) {
    console.log('spoke contracts');
    for (const [name, address] of Object.entries(profile.spokeContracts)) console.log(`  ${name.padEnd(20)} ${address}`);
  }
  console.log('roles');
  for (const [name, role] of Object.entries(profile.roles ?? {})) if (role) console.log(`  ${name.padEnd(20)} ${role.address}${role.key ? '' : '  (no key here)'}`);
  try {
    const health = await fetch(profile.ws.replace(/^ws/, 'http') + '/health').then((r) => r.json());
    console.log(`\nserver health: ${JSON.stringify(health)}`);
  } catch {
    console.log('\nserver: not reachable');
  }
}

async function accounts() {
  const rows = await Promise.all(
    profile.players.map(async (p) => {
      const [hubEth, spokeEth, owed, lms, slms] = await Promise.all([
        hub.getBalance({ address: p.address }),
        spoke ? spoke.getBalance({ address: p.address }) : 0n,
        hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'withdrawable', args: [p.address] }),
        C.lmsToken ? hub.readContract({ address: C.lmsToken, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] }) : 0n,
        C.stakedLms ? hub.readContract({ address: C.stakedLms, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] }) : 0n,
      ]);
      return { p, hubEth, spokeEth, owed, lms, slms };
    }),
  );
  console.log(`     address                                     ${profile.hub.name.padEnd(14)} ${(profile.spoke?.name ?? '').padEnd(16)} escrow     LMS        sLMS`);
  for (const { p, hubEth, spokeEth, owed, lms, slms } of rows) {
    console.log(
      `P${p.n}   ${p.address}  ${eth(hubEth).padStart(14)} ${eth(spokeEth).padStart(16)} ${eth(owed).padStart(9)} ${Number(formatEther(lms)).toFixed(0).padStart(9)} ${Number(formatEther(slms)).toFixed(0).padStart(10)}`,
    );
  }
}

async function lobbies() {
  const nonce = await matchNonce();
  const last = BigInt(flags.last ?? 10);
  const now = (await hub.getBlock()).timestamp;
  if (nonce === 0n) return console.log('No lobbies yet.');
  for (let n = nonce - 1n; n >= 0n && n >= nonce - last; n--) {
    const id = matchIdOf(n);
    const m = await getMatch(id);
    const left = Number(m.joinDeadline) - Number(now);
    const window = m.status === 1 ? (left > 0 ? `${left}s to join` : 'join window over') : '';
    console.log(`#${n}  ${id}  ${STATUS[m.status].padEnd(9)} ${formatEther(m.stake)} ETH  ${m.seatCount}/${m.maxSeats}  ${m.matchmade ? 'matchmade' : 'private  '}  ${window}`);
  }
}

async function resultOf(id, fromBlock) {
  const head = await hub.getBlockNumber();
  const floor = BigInt(fromBlock ?? profile.deployBlock ?? 0);
  for (let to = head; to >= floor; to -= SEARCH_BLOCKS) {
    const from = to - SEARCH_BLOCKS + 1n > floor ? to - SEARCH_BLOCKS + 1n : floor;
    const logs = await hub.getContractEvents({ address: C.escrow, abi: gameEscrowAbi, eventName: 'ResultProposed', args: { matchId: id }, fromBlock: from, toBlock: to });
    if (logs.length > 0) return logs[logs.length - 1].args;
    if (from === floor) break;
  }
  return null;
}

async function status() {
  const id = await resolveMatch(positional[1]);
  const m = await getMatch(id);
  const seats = await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'getSeats', args: [id] });
  const now = Number((await hub.getBlock()).timestamp);
  console.log(`${id}\n  ${STATUS[m.status]} · ${formatEther(m.stake)} ETH · ${m.seatCount}/${m.maxSeats} seats · ${m.matchmade ? 'matchmade' : 'private'}${m.disputed ? ' · DISPUTED' : ''}`);
  if (m.status === 1) console.log(`  join window: ${Number(m.joinDeadline) - now}s left`);
  if (m.status >= 3 && m.status <= 4) console.log(`  deadline: ${new Date(Number(m.deadline) * 1000).toISOString()} (${Number(m.deadline) - now}s from chain time)`);
  const byAddress = new Map(profile.players.map((p) => [p.address.toLowerCase(), `P${p.n}`]));
  for (const [i, seat] of seats.entries()) {
    const [origin, owed] = await Promise.all([
      hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'seatOrigin', args: [id, seat] }),
      hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'withdrawable', args: [seat] }),
    ]);
    console.log(`  seat ${i}  ${seat} ${(byAddress.get(seat.toLowerCase()) ?? '').padEnd(3)} from ${origin === 0 ? profile.hub.name : `chain ${origin}`}  escrow balance ${eth(owed)}`);
  }
  if (m.status >= 4) {
    const result = await resultOf(id);
    if (result) {
      console.log(`  result: ${result.rounds} rounds, transcript ${short(result.transcriptHash)}`);
      result.ranking.forEach((address, i) => console.log(`    ${i + 1}. ${address} ${byAddress.get(address.toLowerCase()) ?? ''}`));
    }
  }
}

// ------------------------------------------------------------------ seating

async function create() {
  const p = player(flags.as);
  const stake = parseEther(String(flags.stake ?? '0.001'));
  const seats = Number(flags.seats ?? 4);
  const receipt = await send('hub', p.key, { address: C.escrow, abi: gameEscrowAbi, functionName: 'createMatch', args: [stake, seats] }, `P${p.n} opens a ${seats}-seat lobby at ${formatEther(stake)} ETH`);
  const [created] = parseEventLogs({ abi: gameEscrowAbi, eventName: 'MatchCreated', logs: receipt.logs });
  console.log(`match ${created.args.matchId}`);
  return created.args.matchId;
}

async function joinOne(id, p, m, how) {
  if (await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'hasSeat', args: [id, p.address] })) {
    console.log(`  P${p.n} already seated`);
    return;
  }
  if (how.from === 'spoke') return joinFromSpoke(id, p, m.stake);
  if (how.token) return joinWithToken(id, p, m.stake, how.token);
  if (how.lms) return joinWithLms(id, p, m.stake, parseEther(String(how.lms)));
  await send('hub', p.key, { address: C.escrow, abi: gameEscrowAbi, functionName: 'join', args: [id], value: m.stake }, `P${p.n} joins on ${profile.hub.name}`);
}

async function joinFromSpoke(id, p, stake) {
  if (!spoke) throw new Error('This network has no spoke.');
  const router = profile.spokeContracts.spokeRouter;
  const now = Number((await spoke.getBlock()).timestamp);
  const { inputAmount, quote } = profile.across.api
    ? await quoteAcross(
        profile.across.api,
        {
          originChainId: profile.spoke.chainId,
          destinationChainId: profile.hub.chainId,
          inputToken: profile.across.spokeWeth,
          outputToken: profile.across.hubWeth,
          recipient: C.bridgeReceiver,
          message: joinMessage(id, p.address, profile.spoke.chainId),
        },
        stake,
      )
    : localQuote(stake, now);
  await send('spoke', p.key, { address: router, abi: spokeRouterAbi, functionName: 'join', args: [id, zeroAddress, quote], value: inputAmount }, `P${p.n} stakes from ${profile.spoke.name} (${formatEther(inputAmount)} ETH incl. ${formatEther(inputAmount - stake)} Across fee)`);
  process.stdout.write(`  P${p.n} in transit…`);
  // A stake that lands in a lobby already full is credited instead of
  // seated: the balance growing is how that shows.
  const owedBefore = await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'withdrawable', args: [p.address] });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'hasSeat', args: [id, p.address] })) {
      console.log(' seated on the hub');
      return;
    }
    const owed = await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'withdrawable', args: [p.address] });
    if (owed > owedBefore) {
      console.log(` not seated: the lobby could not take it, so ${formatEther(owed - owedBefore)} ETH was credited on the hub. Collect it with \`withdraw\`.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    process.stdout.write('.');
  }
  console.log(' not filled after 10 minutes. If the lobby filled meanwhile, the stake is credited: see `withdraw`.');
}

function zapTokens() {
  if (profile.tokens) return profile.tokens;
  const raw = profile.env?.ZAP_TOKENS;
  return raw ? JSON.parse(raw) : [];
}

async function joinWithToken(id, p, stake, symbol) {
  const token = zapTokens().find((t) => t.symbol.toLowerCase() === String(symbol).toLowerCase());
  if (!token) throw new Error(`No ${symbol} route here. Offered: ${zapTokens().map((t) => t.symbol).join(', ') || 'none'}`);
  const quoter = net === 'fork' ? '0x0d5e0f971ed27fbff6c2837bf31316121532048d' : profile.env.V4_QUOTER;
  const path = token.path.map((hop) => ({ hooks: zeroAddress, hookData: '0x', ...hop }));
  const { result } = await hub.simulateContract({ address: quoter, abi: v4QuoterAbi, functionName: 'quoteExactOutput', args: [{ exactCurrency: zeroAddress, path, exactAmount: stake }] });
  const maxIn = maxAmountInFor(result[0]);
  await send('hub', p.key, { address: token.address, abi: erc20Abi, functionName: 'approve', args: [C.zapJoin, 0n] });
  await send('hub', p.key, { address: token.address, abi: erc20Abi, functionName: 'approve', args: [C.zapJoin, maxIn] }, `P${p.n} approves up to ${formatUnits(maxIn, token.decimals)} ${token.symbol}`);
  const deadline = BigInt(Number((await hub.getBlock()).timestamp) + ZAP_DEADLINE_SECONDS);
  await send('hub', p.key, { address: C.zapJoin, abi: zapJoinAbi, functionName: 'joinWithToken', args: [id, path, maxIn, deadline] }, `P${p.n} joins paying ${token.symbol}`);
}

async function joinWithLms(id, p, stake, lmsIn) {
  const [discount, lmsUsed] = await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'quoteLmsDiscount', args: [id, lmsIn] });
  if (discount === 0n) throw new Error('No discount for that much LMS here (is LMS_PER_ETH_DISCOUNT 0 on this chain?).');
  await send('hub', p.key, { address: C.lmsToken, abi: erc20Abi, functionName: 'approve', args: [C.escrow, lmsUsed] });
  await send('hub', p.key, { address: C.escrow, abi: gameEscrowAbi, functionName: 'joinWithLms', args: [id, lmsIn], value: stake - discount }, `P${p.n} joins paying ${formatEther(lmsUsed)} LMS for ${formatEther(discount)} ETH off the fee`);
}

async function join(id = null) {
  id ??= await resolveMatch(positional[1]);
  const m = await getMatch(id);
  if (m.status !== 1) throw new Error(`The lobby is ${STATUS[m.status]}, not Open.`);
  for (const p of players(flags.players ?? '2-4')) await joinOne(id, p, m, flags);
  return id;
}

// --------------------------------------------------------------------- bots

function thinkRange() {
  const [lo, hi] = String(flags.think ?? '800-4000').split('-').map(Number);
  return () => lo + Math.random() * ((hi ?? lo) - lo);
}

/** Plays `list` until each one's match finishes. `extra(p)` adds per-bot options. */
function runBots(list, extra = () => ({})) {
  const think = thinkRange();
  return Promise.all(
    list.map(
      (p) =>
        new Promise((resolve) => {
          const tag = `[P${p.n}]`;
          const bot = new BotClient({
            privateKey: p.key,
            connect: () => wsLink(profile.ws),
            games: 1,
            hold: Boolean(flags.hold),
            thinkMs: think,
            onEvent: (event) => {
              switch (event.type) {
                case 'authed':
                  console.log(`${tag} logged in`);
                  break;
                case 'queued':
                  console.log(`${tag} queued (${event.waiting} waiting)`);
                  break;
                case 'matched':
                  console.log(`${tag} matched into ${event.matchId}`);
                  break;
                case 'waiting':
                  console.log(`${tag} waiting for the table to fill and be seeded…`);
                  break;
                case 'round':
                  if (p === list[0]) console.log(`  round ${event.round} resolved`);
                  break;
                case 'finished':
                  console.log(`${tag} match over`);
                  resolve();
                  break;
                case 'error':
                  console.log(`${tag} error: ${event.message}`);
                  break;
                case 'abandoned':
                  console.log(`${tag} the match was called off and refunded`);
                  resolve();
                  break;
                default:
              }
            },
            ...extra(p),
          });
          bot.start();
        }),
    ),
  );
}

async function bots(id = null) {
  id ??= await resolveMatch(positional[1]);
  const list = players(flags.players ?? '2-4');
  console.log(`${list.length} bots at ${id}. Ctrl+C to stop.`);
  await runBots(list, () => ({ table: id }));
  console.log(`Done. \`npm run play -- status ${id}\` shows how it ended.`);
}

async function fill() {
  const id = await join();
  await bots(id);
}

async function table() {
  const seats = Number(flags.seats ?? 4);
  const humans = Number(flags.humans ?? 1);
  if (humans < 0 || humans > seats) throw new Error('--humans must be between 0 and --seats.');
  flags.as = 1;
  const id = await create();
  const botPlayers = seats > humans ? `${humans + 1}-${seats}` : null;
  if (humans > 0) {
    console.log(`\nYour seats — open these and press Join on match ${short(id)}:`);
    for (let n = 1; n <= humans; n++) console.log(`  P${n}: ${profile.client}/?player=${n}`);
  }
  if (!botPlayers) return;
  flags.players = botPlayers;
  await join(id);
  await bots(id);
}

async function queue() {
  const stake = parseEther(String(flags.stake ?? '0.001'));
  const seats = Number(flags.seats ?? 4);
  const list = players(flags.players ?? '2-4');
  console.log(`${list.length} bots queueing for ${formatEther(stake)} ETH × ${seats}. The table opens when ${seats} players queue, or after the fill delay with ≥4.`);
  await runBots(list, (p) => ({
    queue: { stake: stake.toString(), seats },
    onMatched: async (id) => {
      const m = await getMatch(id);
      await joinOne(id, p, m, flags);
    },
  }));
}

// ---------------------------------------------------------------- lifecycle

async function simple(fn, as, args) {
  const id = await resolveMatch(positional[1]);
  const key = as === 'guardian' ? roleKey('guardian') : player(flags.as).key;
  await send('hub', key, { address: C.escrow, abi: gameEscrowAbi, functionName: fn, args: args ? args(id) : [id] }, `${fn} ${short(id)}`);
}

async function finalize() {
  const id = await resolveMatch(positional[1]);
  const result = await resultOf(id);
  if (!result) throw new Error('No ResultProposed for that match.');
  await send('hub', player(flags.as).key, { address: C.escrow, abi: gameEscrowAbi, functionName: 'finalize', args: [id, result.ranking] }, `finalize ${short(id)}`);
}

async function withdraw() {
  for (const p of players(flags.players ?? 'all')) {
    const owed = await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'withdrawable', args: [p.address] });
    if (owed === 0n) continue;
    await send('hub', p.key, { address: C.escrow, abi: gameEscrowAbi, functionName: 'withdraw', args: [p.address] }, `P${p.n} withdraws ${formatEther(owed)} ETH`);
  }
}

async function pause() {
  await send('hub', roleKey('guardian'), { address: C.escrow, abi: gameEscrowAbi, functionName: 'pause' }, 'guardian pauses the escrow');
}

// ---------------------------------------------------------------- governance

function demoProposal() {
  const bps = Number(flags.bps ?? 6000);
  const salt = flags.salt ?? '1';
  const description = `# Set the stakers' share of fees to ${bps / 100}%\n\nFrom \`npm run play -- gov propose\` (${salt}).`;
  return {
    targets: [C.feeRouter],
    values: [0n],
    calldatas: [encodeFunctionData({ abi: feeRouterAbi, functionName: 'setStakerBps', args: [bps] })],
    description,
    descriptionHash: keccak256(toHex(description)),
  };
}

const PROPOSAL_STATE = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'];

async function gov() {
  const sub = positional[1];
  const g = { address: C.governor, abi: lmsGovernorAbi };
  if (sub === 'propose') {
    const p = player(flags.as);
    const d = demoProposal();
    await send('hub', p.key, { ...g, functionName: 'propose', args: [d.targets, d.values, d.calldatas, d.description] }, `P${p.n} proposes`);
    const id = await hub.readContract({ ...g, functionName: 'hashProposal', args: [d.targets, d.values, d.calldatas, d.descriptionHash] });
    const [snapshot, deadline] = await Promise.all([
      hub.readContract({ ...g, functionName: 'proposalSnapshot', args: [id] }),
      hub.readContract({ ...g, functionName: 'proposalDeadline', args: [id] }),
    ]);
    const now = Number((await hub.getBlock()).timestamp);
    console.log(`proposal ${id}\n  voting opens in ${Number(snapshot) - now}s and closes in ${Number(deadline) - now}s (warp past each on the fork)`);
    return;
  }
  if (sub === 'vote') {
    const id = BigInt(positional[2]);
    const support = { against: 0, for: 1, abstain: 2 }[flags.support ?? 'for'];
    for (const p of players(flags.players ?? '1-4')) await send('hub', p.key, { ...g, functionName: 'castVote', args: [id, support] }, `P${p.n} votes ${flags.support ?? 'for'}`);
    return;
  }
  if (sub === 'state') {
    const id = BigInt(positional[2]);
    const state = await hub.readContract({ ...g, functionName: 'state', args: [id] });
    const [against, forVotes, abstain] = await hub.readContract({ ...g, functionName: 'proposalVotes', args: [id] });
    console.log(`${PROPOSAL_STATE[state]} · for ${formatEther(forVotes)} · against ${formatEther(against)} · abstain ${formatEther(abstain)}`);
    return;
  }
  if (sub === 'queue' || sub === 'execute') {
    const d = demoProposal();
    await send('hub', player(flags.as).key, { ...g, functionName: sub, args: [d.targets, d.values, d.calldatas, d.descriptionHash] }, `${sub} the proposal`);
    if (sub === 'execute') {
      const bps = await hub.readContract({ address: C.feeRouter, abi: feeRouterAbi, functionName: 'stakerBps' });
      console.log(`  stakers' share is now ${Number(bps) / 100}%`);
    }
    return;
  }
  throw new Error('gov propose | vote <id> | state <id> | queue | execute');
}

// ------------------------------------------------------------- play-mining

/**
 * Each player's play-mining: what each ended week would pay if claimed now
 * (a simulated `claim`), and what has vested since. `--claim` claims every
 * ended week into vesting; `--release` releases what has vested.
 */
async function rewards() {
  const rd = { address: C.rewardsDistributor, abi: rewardsDistributorAbi };
  const rv = { address: C.rewardVesting, abi: rewardVestingAbi };
  const epochLength = Number(await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'FEE_EPOCH' }));
  const now = Number((await hub.getBlock()).timestamp);
  const first = await hub.readContract({ ...rd, functionName: 'firstEpoch' });
  const current = BigInt(Math.floor(now / epochLength));
  console.log(`week ${current} in progress · play-mining pays from week ${first}${current <= first ? ' — matches before then earn nothing' : ''}`);
  if (current <= first) return;
  for (const p of players(flags.players ?? 'all')) {
    const [claimable, epochs] = await hub.readContract({ ...rd, functionName: 'claimable', args: [p.address, first, current - 1n] });
    const open = epochs.filter((e) => e > 0n);
    let releasable = 0n;
    const vesting = [];
    for (let e = first; e < current; e++) {
      const amount = await hub.readContract({ ...rv, functionName: 'releasable', args: [p.address, e] });
      if (amount > 0n) {
        releasable += amount;
        vesting.push(e);
      }
    }
    console.log(`P${p.n}  claimable ${formatEther(claimable)} LMS${open.length ? ` (weeks ${open.join(', ')})` : ''} · releasable ${formatEther(releasable)} LMS`);
    if (flags.claim && claimable > 0n) await send('hub', p.key, { ...rd, functionName: 'claim', args: [p.address, open] }, `P${p.n} claims ${formatEther(claimable)} LMS into six months of vesting`);
    if (flags.release && releasable > 0n) await send('hub', p.key, { ...rv, functionName: 'release', args: [p.address, vesting] }, `P${p.n} releases ${formatEther(releasable)} LMS`);
  }
}

// --------------------------------------------------------------------- time

async function rpcCall(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function warp() {
  if (net !== 'fork') throw new Error('Time only moves on a fork. On testnet, wait.');
  const arg = positional[1] ?? '1h';
  let seconds;
  const now = Number((await hub.getBlock()).timestamp);
  if (arg === 'epoch') {
    const epoch = Number(await hub.readContract({ address: C.escrow, abi: gameEscrowAbi, functionName: 'FEE_EPOCH' }));
    seconds = (Math.floor(now / epoch) + 1) * epoch + 60 - now;
  } else {
    seconds = parseDuration(arg);
  }
  for (const url of [profile.hub.rpc, profile.spoke?.rpc].filter(Boolean)) {
    await rpcCall(url, 'evm_increaseTime', [seconds]);
    await rpcCall(url, 'evm_mine', []);
  }
  console.log(`Both forks moved ${seconds}s: chain time ${new Date((now + seconds) * 1000).toISOString()}`);
}

// --------------------------------------------------------------------- main

const COMMANDS = {
  info,
  accounts,
  lobbies,
  status,
  create,
  join: () => join(),
  bots: () => bots(),
  fill,
  table,
  queue,
  lock: () => simple('lockMatch'),
  cancel: () => simple('cancelMatch'),
  finalize,
  dispute: () => simple('dispute', null, (id) => [id, keccak256(toHex(`evidence from npm run play: ${id}`))]),
  veto: () => simple('veto', 'guardian'),
  dismiss: () => simple('dismissDispute', 'guardian'),
  pause,
  withdraw,
  gov,
  rewards,
  warp,
};

if (command === 'help' || !COMMANDS[command]) {
  console.log(HELP);
  process.exit(command === 'help' ? 0 : 1);
}

try {
  await COMMANDS[command]();
  process.exit(0);
} catch (error) {
  console.error(`\n${reason(error)}`);
  process.exit(1);
}
