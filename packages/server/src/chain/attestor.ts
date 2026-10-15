import { concatHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  MATCH_ABORT_TYPES,
  MATCH_RESULT_TYPES,
  addressKey,
  encodeRoundLog,
  matchResultDomain,
  matchResultMessage,
  type MatchResult,
  type RoundRecord,
} from '@lms/protocol';
import { gameEscrowAbi } from '@lms/protocol';
import { config, type ServerConfig } from '../config.js';
import { signerClients } from './viem.js';

/**
 * Signs a finished match under the escrow's EIP-712 domain.
 *
 * The signature commits to the history root, not just the ranking, and the
 * escrow takes the round log alongside it, so a fabricated result can be
 * disproved on-chain by replaying that log (`GameEscrow.challenge`).
 */
export async function signResult(
  privateKey: Hex,
  result: MatchResult,
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
   * Attests a result and proposes it on-chain with its round log. It pays out
   * once the challenge window closes; `ChainBridge` finalises it then.
   * No-op when unconfigured.
   */
  settle(result: MatchResult, history: readonly RoundRecord[]): Promise<Hex | null>;
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
 * Single-key relayer for testnets.
 *
 * Production would collect signatures from independent attestors and only then
 * submit; the escrow enforces the quorum either way, so this is a deployment
 * choice rather than a protocol one.
 */
export function createRelayer(options: {
  privateKey: Hex;
  rpcUrl: string;
  chainId: number;
  escrow: Address;
}): Relayer {
  const { account, publicClient, walletClient } = signerClients(
    options.privateKey,
    options.chainId,
    options.rpcUrl,
  );

  return {
    async abort(matchId) {
      const signature = await privateKeyToAccount(options.privateKey).signTypedData({
        domain: matchResultDomain(options.chainId, options.escrow),
        types: MATCH_ABORT_TYPES,
        primaryType: 'MatchAbort',
        message: { matchId },
      });
      const { request } = await publicClient.simulateContract({
        account,
        address: options.escrow,
        abi: gameEscrowAbi,
        functionName: 'abortMatch',
        args: [matchId, packSignatures([{ signer: account, signature }])],
      });
      return walletClient.writeContract(request);
    },
    async settle(result, history) {
      const signature = await signResult(
        options.privateKey,
        result,
        options.chainId,
        options.escrow,
      );
      const signatures = packSignatures([{ signer: account, signature }]);

      const { request } = await publicClient.simulateContract({
        account,
        address: options.escrow,
        abi: gameEscrowAbi,
        functionName: 'settle',
        args: [
          result.matchId,
          result.rounds,
          result.historyRoot,
          result.ranking,
          signatures,
          encodeRoundLog(result.ranking.length, history),
        ],
      });
      return walletClient.writeContract(request);
    },
  };
}

/**
 * The relayer a given configuration implies.
 *
 * Without an attestor key, or without a chain to submit to, results are still
 * signed and archived but never land on-chain — that is what practice-only
 * mode runs on.
 */
export function relayerFrom(cfg: ServerConfig): Relayer {
  if (!cfg.attestorPk || !cfg.onChain) return nullRelayer;
  return createRelayer({
    privateKey: cfg.attestorPk,
    rpcUrl: cfg.rpcUrl,
    chainId: cfg.chainId,
    escrow: cfg.escrow,
  });
}

export function relayerFromEnv(): Relayer {
  return relayerFrom(config);
}
