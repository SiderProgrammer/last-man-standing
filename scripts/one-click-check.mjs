#!/usr/bin/env node
/**
 * One-click play end to end, on a real EIP-7702 chain: a local anvil, the
 * real deploy, and the server's real relay port.
 *
 *   npm run check:one-click
 *
 * It checks, in order, what FIX_PLAN 5.1 asks of the Privy check, with a
 * local account standing in for the embedded wallet:
 *   1. the account signs a 7702 authorization for `SessionKeyDelegate` and
 *      grants its session key a capped session, in one transaction;
 *   2. the relayer submits a `join` the key signed: the seat is the
 *      account's, the stake the account's, the gas the relayer's;
 *   3. the caps hold: a join above the per-call cap is refused;
 *   4. the key never speaks for the account through ERC-1271;
 *   5. a revoked session fails;
 *   6. a relayed `withdrawFor` can only pay the account.
 *
 * What it cannot check is Privy itself: whether Privy's embedded wallet will
 * sign an authorization for our delegate. That needs a Privy app on Base
 * Sepolia; the account here is a viem local account, which is what Privy's
 * wallet becomes through `toAccount`.
 *
 * Starts its own anvil on CHECK_ANVIL_PORT (default 8599) and stops it after.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  numberToHex,
  parseEther,
  hashMessage,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sessionCallTypedData } from '@lms/consensus';
import {
  ONE_CLICK_CAPS,
  gameEscrowAbi,
  isDelegatedTo,
  joinCall,
  sessionKeyDelegateAbi,
  withdrawForCall,
} from '@lms/contracts';
import { SessionRelay, viemRelayPort, viemTxSender } from '@lms/server';

const PORT = Number(process.env.CHECK_ANVIL_PORT ?? 8599);
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const CONTRACTS = fileURLToPath(new URL('../contracts/', import.meta.url));

// Anvil's public dev keys: worthless anywhere but a local node.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const HOST_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const chain = {
  id: CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const transport = http(RPC);
const rpc = createPublicClient({ chain, transport });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
}

async function refused(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

const anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--hardfork', 'prague', '--silent'], {
  stdio: 'ignore',
});
try {
  await waitForNode();
  const { escrow, delegate } = deploy();

  const player = privateKeyToAccount(generatePrivateKey());
  const sessionKey = privateKeyToAccount(generatePrivateKey());
  const relayer = privateKeyToAccount(RELAYER_KEY);
  await rpc.request({ method: 'anvil_setBalance', params: [player.address, numberToHex(parseEther('1'))] });
  const playerWallet = createWalletClient({ account: player, chain, transport });
  const host = createWalletClient({ account: privateKeyToAccount(HOST_KEY), chain, transport });

  const lobby = async (stake) => {
    const { request, result } = await rpc.simulateContract({
      account: host.account,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'createMatch',
      args: [stake, 4],
    });
    await rpc.waitForTransactionReceipt({ hash: await host.writeContract(request) });
    return result;
  };
  const relay = new SessionRelay({
    port: viemRelayPort({
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      sender: viemTxSender({ privateKey: RELAYER_KEY, chainId: CHAIN_ID, rpcUrl: RPC }, { pollMs: 250, label: 'relay' }),
    }),
    escrow,
    delegate,
    quotaPerDay: 10,
  });
  const signed = async (call) => {
    const nonce = await rpc.readContract({ address: player.address, abi: sessionKeyDelegateAbi, functionName: 'sessionNonce' });
    const params = { ...call, account: player.address, chainId: CHAIN_ID, nonce };
    const signature = await sessionKey.signTypedData(sessionCallTypedData(params));
    return { target: call.target, value: call.value.toString(), data: call.data, nonce: nonce.toString(), signature };
  };

  // 1. Delegate and grant in one transaction.
  const block = await rpc.getBlock();
  const validUntil = Number(block.timestamp) + 24 * 3600;
  const authorization = await playerWallet.signAuthorization({ contractAddress: delegate, executor: 'self' });
  const grant = await playerWallet.sendTransaction({
    to: player.address,
    authorizationList: [authorization],
    data: encodeFunctionData({
      abi: sessionKeyDelegateAbi,
      functionName: 'grantSession',
      args: [sessionKey.address, validUntil, ONE_CLICK_CAPS.valueCap, ONE_CLICK_CAPS.spendCap],
    }),
  });
  await rpc.waitForTransactionReceipt({ hash: grant });
  check(isDelegatedTo(await rpc.getCode({ address: player.address }), delegate), 'the account is delegated to SessionKeyDelegate');
  const active = await rpc.readContract({
    address: player.address,
    abi: sessionKeyDelegateAbi,
    functionName: 'sessionActive',
    args: [sessionKey.address],
  });
  check(active, 'the session key is granted in the same transaction');

  // 2. A relayed join.
  const stake = parseEther('0.01');
  const first = await lobby(stake);
  const [playerBefore, relayerBefore] = await Promise.all([
    rpc.getBalance({ address: player.address }),
    rpc.getBalance({ address: relayer.address }),
  ]);
  const joined = await relay.relay(player.address, await signed(joinCall(escrow, first, stake)));
  const seats = await rpc.readContract({ address: escrow, abi: gameEscrowAbi, functionName: 'getSeats', args: [first] });
  const [playerAfter, relayerAfter] = await Promise.all([
    rpc.getBalance({ address: player.address }),
    rpc.getBalance({ address: relayer.address }),
  ]);
  check(joined.kind === 'join' && seats.length === 1 && seats[0] === player.address, 'the relayer seats the account');
  check(playerBefore - playerAfter === stake, 'the stake, and only the stake, comes from the account');
  check(relayerAfter < relayerBefore, 'the relayer pays the gas');

  // 3. Over the per-call cap.
  const big = await lobby(ONE_CLICK_CAPS.valueCap + 1n);
  const overCap = await refused(relay.relay(player.address, await signed(joinCall(escrow, big, ONE_CLICK_CAPS.valueCap + 1n))));
  check(overCap?.code === 'RELAY_REFUSED' && /ValueCapExceeded/.test(overCap.message), 'a join over the per-call cap is refused');

  // 4. ERC-1271 answers for the account's own key only.
  const hash = hashMessage('one-click check');
  const byKey = await sessionKey.sign({ hash });
  const byRoot = await player.sign({ hash });
  const answer = (signature) =>
    rpc.readContract({ address: player.address, abi: sessionKeyDelegateAbi, functionName: 'isValidSignature', args: [hash, signature] });
  check((await answer(byKey)) === '0xffffffff', 'ERC-1271 refuses the session key');
  check((await answer(byRoot)) === '0x1626ba7e', "ERC-1271 accepts the account's own key");

  // 6. A withdrawal naming anyone else never reaches the chain.
  const elsewhere = await refused(relay.relay(player.address, await signed(withdrawForCall(escrow, relayer.address))));
  check(elsewhere?.code === 'RELAY_REFUSED', 'a relayed withdrawal for someone else is refused');

  // 5. Revoked.
  const revoke = await playerWallet.sendTransaction({
    to: player.address,
    data: encodeFunctionData({ abi: sessionKeyDelegateAbi, functionName: 'revokeSession', args: [sessionKey.address] }),
  });
  await rpc.waitForTransactionReceipt({ hash: revoke });
  const second = await lobby(stake);
  const revoked = await refused(relay.relay(player.address, await signed(joinCall(escrow, second, stake))));
  check(revoked?.code === 'RELAY_REFUSED' && /SessionExpired/.test(revoked.message), 'a revoked session fails');
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  anvil.kill();
}

console.log(failures === 0 ? '\nOne-click play works end to end.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

async function waitForNode() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await rpc.getChainId()) === CHAIN_ID) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`anvil did not come up on ${RPC}`);
}

/** The real deploy script, against the fresh node. */
function deploy() {
  // The broadcast writes the chain's registry and run log, which `dev:fork`
  // also uses for 31337, and `Deploy.t.sol` expects no registry there at all.
  // Whatever was there before is put back.
  const written = [`${CONTRACTS}deployments/${CHAIN_ID}.json`, `${CONTRACTS}broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json`];
  const before = written.map((file) => (existsSync(file) ? readFileSync(file) : null));
  try {
    // Only what forge needs: a developer's `.env` must not change the deploy.
    const env = { DEPLOYER_PK: DEPLOYER_KEY };
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot']) if (process.env[name]) env[name] = process.env[name];
    const result = spawnSync('forge', ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', RPC, '--broadcast', '--slow'], {
      cwd: CONTRACTS,
      env,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`deploy failed:\n${result.stdout}\n${result.stderr}`);
    const registry = JSON.parse(readFileSync(written[0], 'utf8'));
    return { escrow: registry.contracts.escrow, delegate: registry.contracts.sessionDelegate };
  } finally {
    written.forEach((file, index) => {
      if (before[index]) writeFileSync(file, before[index]);
      else rmSync(file, { force: true });
    });
  }
}
