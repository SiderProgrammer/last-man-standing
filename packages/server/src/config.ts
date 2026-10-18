import { availableParallelism } from 'node:os';
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
    rpcUrl: env.RPC_URL ?? '',
    escrow: (env.ESCROW_ADDRESS ?? ZERO_ADDRESS) as `0x${string}`,
    attestorPk: env.ATTESTOR_PK as `0x${string}` | undefined,
    /** Optional key that pays for the permissionless `lockMatch` call. */
    keeperPk: (env.KEEPER_PK ?? env.ATTESTOR_PK) as `0x${string}` | undefined,
    databaseUrl: env.DATABASE_URL ?? '',
    /** Ceiling on practice rooms across all wallets; each wallet holds at most one. */
    maxPracticeRooms: Number(env.MAX_PRACTICE_ROOMS ?? 200),
    /** Sockets open at once, across the server and per client IP. See `gateway/limits.ts`. */
    maxConnections: Number(env.MAX_CONNECTIONS ?? 10_000),
    maxConnectionsPerIp: Number(env.MAX_CONNECTIONS_PER_IP ?? 20),
    /** A socket that has not logged in by then is closed. */
    loginTimeoutMs: Number(env.LOGIN_TIMEOUT_MS ?? 120_000),
    /**
     * Comma-separated `Origin`s the WebSocket handshake accepts, e.g.
     * `https://play.example.com`. Blank accepts any origin, which is what
     * local development wants and production should not.
     */
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    /**
     * Take the client IP from `X-Forwarded-For` instead of the socket. Only
     * behind a proxy that sets it: otherwise any client can claim any IP and
     * walk straight past the per-IP limits.
     */
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    /**
     * Overrides for any field of `DEFAULT_GATEWAY_LIMITS`, as JSON, e.g.
     * `{"connectRatePerIp":1000,"connectBurstPerIp":10000}` for a load test
     * whose clients all come from one IP. Unknown or non-numeric fields are
     * ignored.
     */
    gatewayLimits: parseLimits(env.GATEWAY_LIMITS),
    /**
     * Worker threads that recover login signatures off the event loop. Zero
     * recovers inline. The default leaves one core for the event loop.
     */
    verifyThreads: Number(env.VERIFY_THREADS ?? Math.max(1, Math.min(4, availableParallelism() - 1))),
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
    /**
     * `FeeRouter` on the hub chain. With `KEEPER_PK` set, the server harvests
     * it on a timer so fees reach stakers. Blank disables it; anyone else can
     * still harvest. See `chain/feeKeeper.ts`.
     */
    feeRouter: (env.FEE_ROUTER ?? ZERO_ADDRESS) as `0x${string}`,
    feeKeeperPollMs: Number(env.FEE_KEEPER_POLL_MS ?? 60_000),
    /** Overrides for `DEFAULT_FEE_KEEPER_POLICY`, in wei. Unset keeps the default. */
    feeKeeper: {
      minHarvest: optionalBigInt(env.HARVEST_MIN_WEI),
    },
    /** `StakedLms` on the hub chain. Blank hides the staking panel. */
    stakedLms: (env.STAKED_LMS ?? ZERO_ADDRESS) as `0x${string}`,
    /** `LmsGovernor` on the hub chain. Blank hides the governance screen. */
    governor: (env.GOVERNOR_ADDRESS ?? ZERO_ADDRESS) as `0x${string}`,
    /** First block to look for proposals in: the governor's deployment block. */
    governorFromBlock: optionalBigInt(env.GOVERNOR_FROM_BLOCK) ?? 0n,
    /**
     * Post-match analysis with Claude. On when the SDK has a credential to
     * find in the environment (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`);
     * `ANALYST_ENABLED=true` forces it on for credentials the SDK resolves
     * elsewhere (an `ant auth login` profile), `false` forces it off. Off, the
     * client shows the panel as unavailable and nothing is ever sent anywhere.
     */
    analyst: {
      enabled:
        env.ANALYST_DEMO === 'true' ||
        env.ANALYST_ENABLED === 'true' ||
        (env.ANALYST_ENABLED !== 'false' && Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)),
      /**
       * Answers with the offline demo model instead of Claude: no key, no
       * network, no cost, formulaic prose. For UI work and demos. See `analyst/demo.ts`.
       */
      demo: env.ANALYST_DEMO === 'true',
      model: env.ANALYST_MODEL || 'claude-opus-5-5',
      /** `low` | `medium` | `high` | `xhigh` | `max`. Opus 5.5 defaults to medium; set it explicitly anyway. */
      effort: parseEffort(env.ANALYST_EFFORT),
      /** Output ceiling per model turn, thinking included. Caps the cost of one runaway answer. */
      maxTokens: Number(env.ANALYST_MAX_TOKENS ?? 16_000),
      /** Per attempt; the SDK retries timeouts, 429s and 5xx up to `maxRetries` times. */
      timeoutMs: Number(env.ANALYST_TIMEOUT_MS ?? 120_000),
      maxRetries: Number(env.ANALYST_MAX_RETRIES ?? 2),
      /** Ceiling on one whole analysis, every turn and retry included. */
      deadlineMs: Number(env.ANALYST_DEADLINE_MS ?? 180_000),
      /** Fresh analyses per wallet per hour. Cached answers do not count. */
      quotaPerHour: Number(env.ANALYST_QUOTA_PER_HOUR ?? 6),
      /** Analyses being written at once, server-wide. */
      maxConcurrent: Number(env.ANALYST_MAX_CONCURRENT ?? 4),
      /**
       * Estimated spend per UTC day, in US dollars, after which fresh
       * analyses stop until midnight. `none` lifts the ceiling.
       */
      dailyBudgetUsd: env.ANALYST_DAILY_BUDGET_USD === 'none' ? Infinity : Number(env.ANALYST_DAILY_BUDGET_USD ?? 10),
    },
    /**
     * Bearer token `/metrics` requires, if set. The page shows spend and
     * traffic, which a public server should not hand to anyone who asks.
     */
    metricsToken: env.METRICS_TOKEN ?? '',
    /** True once an escrow is configured and the chain bridge can run. */
    get onChain(): boolean {
      return Boolean(this.rpcUrl) && this.escrow !== ZERO_ADDRESS;
    },
  };
}

/** Numeric fields of a JSON object; anything else is dropped. Throws on invalid JSON. */
function parseLimits(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
  );
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A valid effort level, or `medium` when unset. Throws on anything else rather than sending it. */
function parseEffort(value: string | undefined): (typeof EFFORTS)[number] {
  if (value === undefined || value === '') return 'medium';
  const effort = EFFORTS.find((level) => level === value);
  if (!effort) throw new Error(`ANALYST_EFFORT must be one of ${EFFORTS.join(', ')}`);
  return effort;
}

/** Throws on a value that is not an integer, rather than carrying on with garbage. */
function optionalBigInt(value: string | undefined): bigint | undefined {
  return value === undefined || value === '' ? undefined : BigInt(value);
}

export const config = loadConfig();

export { ZERO_ADDRESS };
