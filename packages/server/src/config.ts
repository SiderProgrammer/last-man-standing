import { ZERO_ADDRESS } from '@lms/protocol';

export type ServerConfig = ReturnType<typeof loadConfig>;

/**
 * Reads the server's configuration out of an environment.
 *
 * Taking `env` as an argument rather than reaching for `process.env` directly
 * is what makes this testable, and it is the only change here: the parsing is
 * deliberately left exactly as it was, including the parts that are wrong.
 * `Number()` still yields `NaN` for a non-numeric value and nothing rejects
 * it, the address fields are still unchecked casts, and `KEEPER_PK` still
 * falls back to `ATTESTOR_PK`. Each is recorded in `docs/TODO.md` §3.4 and pinned by
 * `test/config.test.ts`; fixing them is a behaviour change, not a refactor.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: Number(env.WS_PORT ?? 8787),
    chainId: Number(env.CHAIN_ID ?? 11155111),
    commitMs: Number(env.COMMIT_MS ?? 20_000),
    revealMs: Number(env.REVEAL_MS ?? 12_000),
    /** Hold after each round so clients can replay it before the next clock starts. */
    replayMs: Number(env.REPLAY_MS ?? 2_500),
    startingChips: Number(env.STARTING_CHIPS ?? 1_000),
    rpcUrl: env.RPC_URL ?? '',
    escrow: (env.ESCROW_ADDRESS ?? ZERO_ADDRESS) as `0x${string}`,
    attestorPk: env.ATTESTOR_PK as `0x${string}` | undefined,
    /** Optional key that pays for the permissionless `lockMatch` call. */
    keeperPk: (env.KEEPER_PK ?? env.ATTESTOR_PK) as `0x${string}` | undefined,
    databaseUrl: env.DATABASE_URL ?? '',
    /**
     * `PlayerAvatars` deployments, as JSON:
     * `[{"chainId":11155111,"address":"0x…","rpcUrl":"https://…"}]`
     *
     * One entry per chain players mint on, because the collection is deployed
     * per chain rather than bridged. Reading a spoke's collection needs that
     * spoke's RPC, which is why the URL travels with the address.
     */
    avatarCollections: env.AVATAR_COLLECTIONS ?? '',
    /** Prefix `ipfs://` is rewritten to when fetching avatar metadata. */
    ipfsGateway: env.IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/',
    /**
     * `SessionKeyDelegate` on the hub chain. Players delegate their EOA to it
     * under EIP-7702 so the client can sign logins with a scoped session key
     * instead of prompting the wallet on every reconnect. Blank disables the
     * offer; logins then always cost a wallet signature.
     */
    sessionDelegate: (env.SESSION_DELEGATE ?? ZERO_ADDRESS) as `0x${string}`,
    /** `ZapJoin` on the hub chain. Blank disables paying in tokens; ETH still works. */
    zapJoin: (env.ZAP_JOIN ?? ZERO_ADDRESS) as `0x${string}`,
    /** v4-periphery `V4Quoter` on the hub chain, which the client prices routes with. */
    v4Quoter: (env.V4_QUOTER ?? ZERO_ADDRESS) as `0x${string}`,
    /** Tokens offered through the zap, each with its v4 route to ETH, as JSON. See `chain/zap.ts`. */
    zapTokens: env.ZAP_TOKENS ?? '',
    /** True once an escrow is configured and the chain bridge can run. */
    get onChain(): boolean {
      return Boolean(this.rpcUrl) && this.escrow !== ZERO_ADDRESS;
    },
  };
}

export const config = loadConfig();

export { ZERO_ADDRESS };
