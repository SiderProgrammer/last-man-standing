import { concatHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  MATCH_ABORT_TYPES,
  MATCH_RESULT_TYPES,
  addressKey,
  matchResultDomain,
  matchResultMessage,
  receiptTypedData,
  type AttestedResult,
} from '@lms/protocol';
import type { ReceiptSigner } from '../gateway/gateway.js';
import { gameEscrowAbi } from '@lms/protocol';
import type { ServerConfig } from '../config.js';
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
 * Signs commit receipts with `privateKey`. The server uses the attestor key
 * where it has one: then the escrow's attestor set is what vouches for the
 * receipts, and a player can check a receipt against the chain.
 */
export function receiptSigner(privateKey: Hex, chainId: number): ReceiptSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    sign: (receipt) => account.signTypedData(receiptTypedData(chainId, receipt)),
  };
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
   * Attests a result and proposes it on-chain. It pays out once the challenge
   * window closes unvetoed; `ChainBridge` finalises it then.
   * No-op when unconfigured.
   */
  settle(result: AttestedResult): Promise<Hex | null>;
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
 * Single-key relayer for testnets: signs with the attestor key, and submits
 * through `sender`.
 *
 * Production would collect signatures from independent attestors and only then
 * submit; the escrow enforces the quorum either way, so this is a deployment
 * choice rather than a protocol one.
 */
export function createRelayer(options: {
  privateKey: Hex;
  chainId: number;
  escrow: Address;
  sender: TxSender;
}): Relayer {
  const account = privateKeyToAccount(options.privateKey);
  const { escrow, sender } = options;

  return {
    async abort(matchId) {
      const signature = await account.signTypedData({
        domain: matchResultDomain(options.chainId, escrow),
        types: MATCH_ABORT_TYPES,
        primaryType: 'MatchAbort',
        message: { matchId },
      });
      return sender.sendAndWait(`abortMatch:${matchId.toLowerCase()}`, {
        address: escrow,
        abi: gameEscrowAbi,
        functionName: 'abortMatch',
        args: [matchId, packSignatures([{ signer: account.address, signature }])],
      });
    },
    async settle(result) {
      const signature = await signResult(options.privateKey, result, options.chainId, escrow);
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
          packSignatures([{ signer: account.address, signature }]),
        ],
      });
    },
  };
}

/**
 * The relayer a given configuration implies, submitting through `sender`.
 *
 * Without an attestor key, or without a chain to submit to, results are still
 * signed and archived but never land on-chain — that is what practice-only
 * mode runs on.
 */
export function relayerFrom(cfg: ServerConfig, sender: TxSender | null): Relayer {
  if (!cfg.attestorPk || !cfg.onChain || !sender) return nullRelayer;
  return createRelayer({ privateKey: cfg.attestorPk, chainId: cfg.chainId, escrow: cfg.escrow, sender });
}
