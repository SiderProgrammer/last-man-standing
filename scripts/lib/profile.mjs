/**
 * Where `npm run play` and `npm run testnet` find a network: its two chains,
 * every contract, the game server, and the player accounts.
 *
 *   fork     written by `npm run fork:base` to contracts/deployments/fork/profile.json
 *   testnet  Base Sepolia + its spokes (Arbitrum Sepolia, OP Sepolia,
 *            Sepolia), from the committed registries, the root `.env`, and
 *            `.testnet-accounts.json`
 */
import { existsSync, readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = new URL('../../', import.meta.url);
export const FORK_PROFILE = new URL('contracts/deployments/fork/profile.json', ROOT);
export const TESTNET_ACCOUNTS = new URL('.testnet-accounts.json', ROOT);

/** `.env` as an object. Values already in the process environment win, as with the server's own `--env-file`. */
export function readDotEnv() {
  const file = new URL('.env', ROOT);
  const values = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== '') values[key] = value;
  }
  return values;
}

function readJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The generated testnet players, or an empty list before `npm run testnet -- accounts`. */
export function testnetPlayers() {
  if (!existsSync(TESTNET_ACCOUNTS)) return [];
  return readJson(TESTNET_ACCOUNTS).players.map((player, i) => ({
    n: i + 1,
    key: player.key,
    address: privateKeyToAccount(player.key).address,
  }));
}

export const TESTNET = {
  hubChainId: 84532,
  /**
   * The testnet spokes, in the order `--spoke` falls back through: the first
   * one with a registry is the default. `alias` is what `--spoke` takes,
   * besides the chain id; `rpcEnv` is the `.env` variable that overrides the
   * public RPC.
   */
  spokes: [
    { chainId: 421614, alias: 'arb', name: 'Arbitrum Sepolia', rpcEnv: 'ARBITRUM_SEPOLIA_RPC', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
    { chainId: 11155420, alias: 'op', name: 'OP Sepolia', rpcEnv: 'OP_SEPOLIA_RPC', rpc: 'https://sepolia.optimism.io' },
    // publicnode's Sepolia endpoint load-balances across nodes that disagree
    // on the head ("block not found"); Tenderly's gateway does not.
    { chainId: 11155111, alias: 'eth', name: 'Sepolia', rpcEnv: 'SEPOLIA_RPC', rpc: 'https://sepolia.gateway.tenderly.co' },
  ],
  vrfCoordinator: '0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE',
  across: 'https://testnet.across.to/api',
  v4Quoter: '0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba',
};

/** Every testnet spoke that has a registry, with its contracts. */
function testnetSpokes(env) {
  return TESTNET.spokes.flatMap((spoke) => {
    const file = new URL(`contracts/deployments/${spoke.chainId}.json`, ROOT);
    if (!existsSync(file)) return [];
    const registry = readJson(file);
    return [
      {
        chainId: spoke.chainId,
        alias: spoke.alias,
        name: spoke.name,
        rpc: env[spoke.rpcEnv] || spoke.rpc,
        contracts: registry.contracts,
        deployBlock: registry.deployBlock ?? 0,
      },
    ];
  });
}

/** The spoke `--spoke` names (alias, chain id or name), or the first one. */
function pickSpoke(spokes, which) {
  if (which === undefined || which === null || which === true) return spokes[0] ?? null;
  const wanted = String(which).toLowerCase();
  const found = spokes.find((s) => s.alias === wanted || String(s.chainId) === wanted || s.name.toLowerCase() === wanted);
  if (!found) {
    const known = spokes.map((s) => `${s.alias} (${s.chainId})`).join(', ') || 'none deployed';
    throw new Error(`No spoke "${which}": ${known}.`);
  }
  return found;
}

function testnetProfile(options = {}) {
  const env = readDotEnv();
  const hubFile = new URL(`contracts/deployments/${TESTNET.hubChainId}.json`, ROOT);
  if (!existsSync(hubFile)) throw new Error(`No ${hubFile.pathname}: deploy the hub first (docs/TESTNET.md).`);
  const hub = readJson(hubFile);
  const spokes = testnetSpokes(env);
  const picked = pickSpoke(spokes, options.spoke ?? env.PLAY_SPOKE);
  const key = (name) => (/^0x[0-9a-fA-F]{64}$/.test(env[name] ?? '') ? env[name] : null);
  const roleFromKey = (name) => {
    const pk = key(name);
    return pk ? { key: pk, address: privateKeyToAccount(pk).address } : null;
  };
  return {
    net: 'testnet',
    hub: {
      chainId: TESTNET.hubChainId,
      name: 'Base Sepolia',
      // The server's RPC first: it has to allow wide log ranges, which `status` and `finalize` use too.
      rpc: env.PLAY_HUB_RPC || (String(env.CHAIN_ID ?? '84532') === '84532' && env.RPC_URL) || env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
    },
    // The spoke this run acts on (`--spoke`), and every deployed one, which
    // the server lists and `doctor` checks.
    spoke: picked && {
      chainId: picked.chainId,
      name: picked.name,
      rpc: env.PLAY_SPOKE_RPC || picked.rpc,
    },
    spokes,
    ws: env.PLAY_WS_URL || `ws://localhost:${env.WS_PORT || 8787}`,
    client: env.PLAY_CLIENT_URL || 'http://localhost:5173',
    deployBlock: hub.deployBlock,
    spokeDeployBlock: picked?.deployBlock ?? 0,
    contracts: hub.contracts,
    spokeContracts: picked?.contracts ?? {},
    vrf: { coordinator: TESTNET.vrfCoordinator, subId: env.VRF_SUBSCRIPTION_ID || null },
    across: {
      hubPool: hub.contracts.acrossSpokePool,
      spokePool: picked?.contracts.acrossSpokePool,
      hubWeth: hub.contracts.weth,
      spokeWeth: picked?.contracts.weth,
      api: env.VITE_ACROSS_API || TESTNET.across,
    },
    roles: {
      deployer: roleFromKey('DEPLOYER_PK'),
      attestor: roleFromKey('ATTESTOR_PK'),
      keeper: roleFromKey('KEEPER_PK'),
      matchmaker: roleFromKey('MATCHMAKER_PK'),
      sessionRelayer: roleFromKey('SESSION_RELAYER_PK'),
      // Optional: only for `veto`, `dismiss` and `pause` from the command line.
      guardian: roleFromKey('GUARDIAN_PK') ?? (env.GUARDIAN ? { address: env.GUARDIAN, key: null } : null),
      safe: env.SAFE ? { address: env.SAFE, key: null } : null,
    },
    players: testnetPlayers(),
    env,
  };
}

/**
 * The profile for `net`: `fork` or `testnet`. `options.spoke` (an alias,
 * chain id or name; on testnet also `PLAY_SPOKE`) picks which spoke
 * `profile.spoke` is; `profile.spokes` lists every one.
 */
export function loadProfile(net, options = {}) {
  if (net === 'testnet') return testnetProfile(options);
  if (net !== 'fork') throw new Error(`Unknown network "${net}": use fork or testnet.`);
  if (!existsSync(FORK_PROFILE)) throw new Error('No fork is running: start one with `npm run fork:base` first.');
  const fork = readJson(FORK_PROFILE);
  // A profile from before the fork ran several spokes has only `spoke`.
  const spokes =
    fork.spokes ??
    (fork.spoke
      ? [{ ...fork.spoke, alias: 'arb', contracts: fork.spokeContracts, deployBlock: fork.spokeDeployBlock ?? 0, pool: fork.across.spokePool, weth: fork.across.spokeWeth }]
      : []);
  const picked = pickSpoke(spokes, options.spoke);
  if (!picked) return { ...fork, spokes };
  return {
    ...fork,
    spokes,
    spoke: { chainId: picked.chainId, name: picked.name, rpc: picked.rpc },
    spokeContracts: picked.contracts,
    spokeDeployBlock: picked.deployBlock ?? 0,
    across: { ...fork.across, spokePool: picked.pool, spokeWeth: picked.weth },
  };
}
