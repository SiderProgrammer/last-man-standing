import { concatHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  MATCH_RESULT_TYPES,
  addressKey,
  matchResultDomain,
  matchResultMessage,
  receiptTypedData,
  type AttestedResult,
  type Transcript,
} from '@lms/protocol';
import type { ReceiptSigner } from '../gateway/gateway.js';
import { gameEscrowAbi } from '@lms/protocol';
import type { ServerConfig } from '../config.js';
import type { Attestor } from '../attestor/service.js';
import type { TxSender } from './txSender.js';

/**
 * Signs a finished match under the escrow's EIP-712 domain.
 *
 * The signature commits to the history root, not just the ranking, so anyone
 * holding the archived rounds can replay the match and see whether the result
 * follows from them; the guardian vetoes one that does not (`GameEscrow.veto`).
 */
export async function signResult(
  privateKey: Hex,
  result: AttestedResult,
  chainId: number,
  escrow: Address,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({
    domain: matchResultDomain(chainId, escrow),
    types: MATCH_RESULT_TYPES,
    primaryType: 'MatchResult',
    message: matchResultMessage(result),
  });
}

/**
 * Signs commit receipts with `privateKey`. A staked room's receipts come from
 * the attestor instead (`attestorReceipts`), so the escrow's attestor set
 * vouches for them; this is for practice rooms and tests.
 */
export function receiptSigner(privateKey: Hex, chainId: number): ReceiptSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    sign: (receipt) => account.signTypedData(receiptTypedData(chainId, receipt)),
  };
}

/** Commit receipts signed by the attestor. */
export function attestorReceipts(attestor: Attestor): ReceiptSigner {
  return { address: attestor.address, sign: (receipt) => attestor.receipt(receipt) };
}

/**
 * `SignatureLib` requires strictly ascending signer addresses, which is how it
 * rejects a duplicate signature standing in for a quorum.
 */
export function packSignatures(signed: ReadonlyArray<{ signer: Address; signature: Hex }>): Hex {
  const ordered = [...signed].sort((a, b) =>
    addressKey(a.signer) < addressKey(b.signer) ? -1 : 1,
  );
  return concatHex(ordered.map((item) => item.signature));
}

export interface Relayer {
  /**
   * Has the attestor sign a result, then proposes it on-chain. It pays out
   * once the challenge window closes unvetoed; `ChainBridge` finalises it
   * then. No-op when unconfigured.
   *
   * @param transcript What the result came from: the attestor replays it,
   *        and signs nothing it does not reproduce.
   */
  settle(result: AttestedResult, transcript: Transcript): Promise<Hex | null>;
  /**
   * Signs and submits an abort for a live match this server cannot finish,
   * refunding every seat at once. Null when unconfigured; the escrow then
   * refunds through `cancelMatch` once the settlement deadline passes.
   */
  abort(matchId: `0x${string}`): Promise<Hex | null>;
}

/** Relayer that logs instead of transacting: the default for practice lobbies. */
export const nullRelayer: Relayer = {
  settle: async () => null,
  abort: async () => null,
};

/**
 * The attestor's signature, sent by the keeper.
 *
 * Two keys, two jobs: the attestor (its own process, `attestor/process.ts`)
 * signs, and never sends a transaction; the keeper's sender pays the gas and
 * holds no authority, since `settle` checks the signatures and not the
 * sender. Production would collect a quorum of independent attestors here;
 * the escrow enforces the quorum either way, so that is a deployment choice
 * rather than a protocol one.
 */
export function createRelayer(options: { attestor: Attestor; sender: TxSender; escrow: Address }): Relayer {
  const { attestor, escrow, sender } = options;
  return {
    async abort(matchId) {
      const signature = await attestor.abort(matchId);
      return sender.sendAndWait(`abortMatch:${matchId.toLowerCase()}`, {
        address: escrow,
        abi: gameEscrowAbi,
        functionName: 'abortMatch',
        args: [matchId, packSignatures([{ signer: attestor.address, signature }])],
      });
    },
    async settle(result, transcript) {
      const signature = await attestor.attest(transcript);
      return sender.sendAndWait(`settle:${result.matchId.toLowerCase()}`, {
        address: escrow,
        abi: gameEscrowAbi,
        functionName: 'settle',
        args: [
          result.matchId,
          result.rounds,
          result.historyRoot,
          result.transcriptHash,
          result.ranking,
          packSignatures([{ signer: attestor.address, signature }]),
        ],
      });
    },
  };
}

/**
 * The relayer a configuration implies: an attestor to sign, a keeper to
 * send, and an escrow to send to. Without all three, results are still
 * archived but never land on-chain — that is what practice-only mode runs on.
 */
export function relayerFrom(cfg: ServerConfig, attestor: Attestor | null, keeper: TxSender | null): Relayer {
  if (!attestor || !keeper || !cfg.onChain) return nullRelayer;
  return createRelayer({ attestor, sender: keeper, escrow: cfg.escrow });
}
