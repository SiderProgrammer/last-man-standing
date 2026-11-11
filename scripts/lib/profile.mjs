/**
 * Where `npm run play` and `npm run testnet` find a network: its two chains,
 * every contract, the game server, and the player accounts.
 *
 *   fork     written by `npm run fork:base` to contracts/deployments/fork/profile.json
 *   testnet  Base Sepolia + Arbitrum Sepolia, from the committed registries,
 *            the root `.env`, and `.testnet-accounts.json`
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
  spokeChainId: 421614,
  vrfCoordinator: '0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE',
  across: 'https://testnet.across.to/api',
  v4Quoter: '0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba',
};

function testnetProfile() {
  const env = readDotEnv();
  const hubFile = new URL(`contracts/deployments/${TESTNET.hubChainId}.json`, ROOT);
  const spokeFile = new URL(`contracts/deployments/${TESTNET.spokeChainId}.json`, ROOT);
  if (!existsSync(hubFile)) throw new Error(`No ${hubFile.pathname}: deploy the hub first (docs/TESTNET.md).`);
  const hub = readJson(hubFile);
  const spoke = existsSync(spokeFile) ? readJson(spokeFile) : null;
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
    spoke: spoke && {
      chainId: TESTNET.spokeChainId,
      name: 'Arbitrum Sepolia',
      rpc: env.PLAY_SPOKE_RPC || env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc',
    },
    ws: env.PLAY_WS_URL || `ws://localhost:${env.WS_PORT || 8787}`,
    client: env.PLAY_CLIENT_URL || 'http://localhost:5173',
    deployBlock: hub.deployBlock,
    spokeDeployBlock: spoke?.deployBlock ?? 0,
    contracts: hub.contracts,
    spokeContracts: spoke?.contracts ?? {},
    vrf: { coordinator: TESTNET.vrfCoordinator, subId: env.VRF_SUBSCRIPTION_ID || null },
    across: {
      hubPool: hub.contracts.acrossSpokePool,
      spokePool: spoke?.contracts.acrossSpokePool,
      hubWeth: hub.contracts.weth,
      spokeWeth: spoke?.contracts.weth,
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

/** The profile for `net`: `fork` or `testnet`. */
export function loadProfile(net) {
  if (net === 'testnet') return testnetProfile();
  if (net !== 'fork') throw new Error(`Unknown network "${net}": use fork or testnet.`);
  if (!existsSync(FORK_PROFILE)) throw new Error('No fork is running: start one with `npm run fork:base` first.');
  return readJson(FORK_PROFILE);
}
