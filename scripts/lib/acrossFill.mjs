/**
 * Filling a spoke's Across deposit on the hub ourselves, as a relayer would.
 *
 * Across's testnet relayers leave deposits that carry a message unfilled
 * (docs/ACROSS.md), and every spoke join carries one, so on testnet a join
 * from a spoke lands only if we fill it. `npm run play -- join --relay` and
 * `npm run play -- relay` fill one deposit; `npm run testnet -- up --relay`
 * fills every join the test players make, from any spoke.
 */
import { erc20Abi, formatEther } from 'viem';

/** The parts of Across's SpokePool and WETH a relayer uses. */
export const acrossFillAbi = [
  {
    type: 'event',
    name: 'FundsDeposited',
    inputs: [
      { name: 'inputToken', type: 'bytes32', indexed: false },
      { name: 'outputToken', type: 'bytes32', indexed: false },
      { name: 'inputAmount', type: 'uint256', indexed: false },
      { name: 'outputAmount', type: 'uint256', indexed: false },
      { name: 'destinationChainId', type: 'uint256', indexed: true },
      { name: 'depositId', type: 'uint256', indexed: true },
      { name: 'quoteTimestamp', type: 'uint32', indexed: false },
      { name: 'fillDeadline', type: 'uint32', indexed: false },
      { name: 'exclusivityDeadline', type: 'uint32', indexed: false },
      { name: 'depositor', type: 'bytes32', indexed: true },
      { name: 'recipient', type: 'bytes32', indexed: false },
      { name: 'exclusiveRelayer', type: 'bytes32', indexed: false },
      { name: 'message', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'fillRelay',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'relayData',
        type: 'tuple',
        components: [
          { name: 'depositor', type: 'bytes32' },
          { name: 'recipient', type: 'bytes32' },
          { name: 'exclusiveRelayer', type: 'bytes32' },
          { name: 'inputToken', type: 'bytes32' },
          { name: 'outputToken', type: 'bytes32' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'outputAmount', type: 'uint256' },
          { name: 'originChainId', type: 'uint256' },
          { name: 'depositId', type: 'uint256' },
          { name: 'fillDeadline', type: 'uint32' },
          { name: 'exclusivityDeadline', type: 'uint32' },
          { name: 'message', type: 'bytes' },
        ],
      },
      { name: 'repaymentChainId', type: 'uint256' },
      { name: 'repaymentAddress', type: 'bytes32' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
];

/** An address as Across's bytes32. */
export const toBytes32 = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

/** Across's bytes32 back to an address. */
export const fromBytes32 = (word) => `0x${word.slice(-40)}`;

/**
 * Fills deposit `d` (the decoded `FundsDeposited` args) on the hub from the
 * relayer: wraps what WETH it lacks, approves the hub pool, and calls its
 * `fillRelay`, which pays `BridgeJoinReceiver` and runs the join. Repayment
 * is asked for on the hub; Across's testnet may never make it, so each fill
 * costs the relayer the stake.
 *
 * `send(request, label)` simulates, sends and waits on the hub as the
 * relayer, and throws on a revert.
 */
export async function fillDeposit({ hub, send, relayer, d, originChainId, hubChainId, hubPool, hubWeth }) {
  if (Number(d.destinationChainId) !== hubChainId) throw new Error(`That deposit goes to chain ${d.destinationChainId}, not the hub.`);
  const now = Number((await hub.getBlock()).timestamp);
  if (now > d.fillDeadline) throw new Error(`Deposit ${d.depositId} expired at ${new Date(d.fillDeadline * 1000).toISOString()}: it can no longer be filled.`);

  const read = (functionName, args) => hub.readContract({ address: hubWeth, abi: erc20Abi, functionName, args });
  const held = await read('balanceOf', [relayer]);
  if (held < d.outputAmount) {
    await send({ address: hubWeth, abi: acrossFillAbi, functionName: 'deposit', value: d.outputAmount - held }, `relayer wraps ${formatEther(d.outputAmount - held)} ETH`);
  }
  if ((await read('allowance', [relayer, hubPool])) < d.outputAmount) {
    await send({ address: hubWeth, abi: erc20Abi, functionName: 'approve', args: [hubPool, d.outputAmount] }, 'relayer approves the hub pool');
  }
  const relayData = {
    depositor: d.depositor,
    recipient: d.recipient,
    exclusiveRelayer: d.exclusiveRelayer,
    inputToken: d.inputToken,
    outputToken: d.outputToken,
    inputAmount: d.inputAmount,
    outputAmount: d.outputAmount,
    originChainId: BigInt(originChainId),
    depositId: d.depositId,
    fillDeadline: d.fillDeadline,
    exclusivityDeadline: d.exclusivityDeadline,
    message: d.message,
  };
  return send(
    { address: hubPool, abi: acrossFillAbi, functionName: 'fillRelay', args: [relayData, BigInt(hubChainId), toBytes32(relayer)] },
    `relayer fills deposit ${d.depositId} from chain ${originChainId}`,
  );
}
