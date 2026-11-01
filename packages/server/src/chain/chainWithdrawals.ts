import type { Address, Hex } from 'viem';
import { ZERO_ADDRESS, sameAddress, type ChainWithdrawal } from '@lms/consensus';
import {
  bridgeJoinReceiverAbi,
  gameEscrowAbi,
  protocolConfigAbi,
  type BridgeQuote,
} from '@lms/contracts';
import {
  quoteFromWire,
  withdrawalFromWire,
  type ClientMessage,
  type SpokeInfo,
} from '@lms/api';
import { RequestError } from '../errors.js';
import { revertReason, type DailyQuota } from './sessionRelay.js';
import type { TxSender } from './txSender.js';
import { readClient } from './viem.js';

/**
 * Submits withdrawals to a spoke that players signed, and pays the hub gas.
 *
 * A player who staked from a spoke is paid on the hub, where they may hold
 * no gas at all. They sign a `Withdrawal` of their whole balance on their
 * own chain, and the server sends it to `BridgeJoinReceiver.withdrawToChainFor`,
 * which bridges the balance home through Across with the fee taken from it.
 *
 * The receiver checks the signature, the nonce, the fee cap and the minimum;
 * nothing here can send anyone's balance anywhere they did not sign for.
 * What the server guards is its own gas, as for session calls: a socket may
 * submit only its own wallet's withdrawal, to a spoke this server serves; it
 * is simulated before it is sent; and it counts against the same daily quota.
 */
export interface WithdrawalPort {
  /** `player`'s balance in the escrow and the receiver's terms for a withdrawal of it. */
  balance(player: Address): Promise<HubBalance>;
  /** Simulates `withdrawToChainFor` from the relayer, then sends it and waits. Throws on a revert at either stage. */
  submit(withdrawal: ChainWithdrawal, quote: BridgeQuote, signature: Hex): Promise<Hex>;
}

export interface HubBalance {
  amount: bigint;
  /** `BridgeJoinReceiver`, which the withdrawal is signed to. */
  receiver: Address;
  nonce: bigint;
  /** `GameEscrow.MIN_WITHDRAW_FOR`: the least the receiver will bridge. */
  minimum: bigint;
  /** The hub's latest block time. */
  chainTime: number;
}

export interface ChainWithdrawalsOptions {
  port: WithdrawalPort;
  hubChainId: number;
  spokes: readonly SpokeInfo[];
  quota: DailyQuota;
}

export class ChainWithdrawals {
  constructor(private readonly options: ChainWithdrawalsOptions) {}

  balance(account: Address): Promise<HubBalance> {
    return this.options.port.balance(account);
  }

  async submit(
    account: Address,
    message: Extract<ClientMessage, { type: 'withdrawToChain' }>,
  ): Promise<{ tx: Hex; left: number }> {
    const withdrawal = withdrawalFromWire(message.withdrawal);
    if (!sameAddress(withdrawal.player, account)) {
      throw new RequestError('RELAY_REFUSED', 'only your own withdrawal can be submitted from this login');
    }
    if (withdrawal.hubChainId !== BigInt(this.options.hubChainId)) {
      throw new RequestError('RELAY_REFUSED', 'that withdrawal is for another hub');
    }
    if (!this.options.spokes.some((spoke) => BigInt(spoke.chainId) === withdrawal.destinationChainId)) {
      throw new RequestError('RELAY_REFUSED', 'this server does not bridge to that chain');
    }

    const { quota } = this.options;
    quota.take(account);
    try {
      const tx = await this.options.port
        .submit(withdrawal, quoteFromWire(message.quote), message.signature)
        .catch((error: unknown) => {
          throw new RequestError('RELAY_REFUSED', `the withdrawal would fail: ${revertReason(error)}`);
        });
      return { tx, left: quota.left(account) };
    } catch (error) {
      quota.giveBack(account);
      throw error;
    }
  }
}

/**
 * `WithdrawalPort` over viem, sending with the session relayer's key: the
 * same key pays for both, so the same quota limits both.
 *
 * The receiver is looked up through the escrow's config on every call, so a
 * receiver governance replaces is picked up without a restart.
 */
export function viemWithdrawalPort(options: {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  sender: TxSender;
}): WithdrawalPort {
  const client = readClient(options.chainId, options.rpcUrl);
  const escrow = { address: options.escrow, abi: gameEscrowAbi } as const;

  const receiver = async (): Promise<Address> => {
    const config = await client.readContract({ ...escrow, functionName: 'config' });
    const address = await client.readContract({ address: config, abi: protocolConfigAbi, functionName: 'bridgeReceiver' });
    if (sameAddress(address, ZERO_ADDRESS)) {
      throw new RequestError('UNAVAILABLE', 'the hub has no bridge receiver to withdraw through');
    }
    return address;
  };

  return {
    async balance(player) {
      const at = await receiver();
      const [amount, nonce, minimum, block] = await Promise.all([
        client.readContract({ ...escrow, functionName: 'withdrawable', args: [player] }),
        client.readContract({ address: at, abi: bridgeJoinReceiverAbi, functionName: 'nonces', args: [player] }),
        client.readContract({ ...escrow, functionName: 'MIN_WITHDRAW_FOR' }),
        client.getBlock(),
      ]);
      return { amount, receiver: at, nonce, minimum, chainTime: Number(block.timestamp) };
    },
    async submit(withdrawal, quote, signature) {
      return options.sender.sendAndWait(`withdraw:${withdrawal.player.toLowerCase()}:${withdrawal.nonce}`, {
        address: await receiver(),
        abi: bridgeJoinReceiverAbi,
        functionName: 'withdrawToChainFor',
        args: [withdrawal, quote, signature],
      });
    },
  };
}
