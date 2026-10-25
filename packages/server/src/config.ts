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
    /** `RewardsDistributor` on the hub chain. Blank hides the play-mining claim. */
    rewardsDistributor: (env.REWARDS_DISTRIBUTOR ?? ZERO_ADDRESS) as `0x${string}`,
    /** `LmsGovernor` on the hub chain. Blank hides the governance screen. */
    governor: (env.GOVERNOR_ADDRESS ?? ZERO_ADDRESS) as `0x${string}`,
    /** First block to look for proposals in: the governor's deployment block. */
    governorFromBlock: optionalBigInt(env.GOVERNOR_FROM_BLOCK) ?? 0n,
    /**
     * Post-match analysis with Gemini. On when `GEMINI_API_KEY` is set;
     * `ANALYST_ENABLED=false` forces it off. Off, the client shows the panel
     * as unavailable and nothing is ever sent anywhere.
     */
    analyst: {
      enabled: env.ANALYST_ENABLED !== 'false' && Boolean(env.GEMINI_API_KEY),
      /** A Gemini 3 model or later: the first to combine structured output with function calling. */
      model: env.ANALYST_MODEL || 'gemini-3.8-flash',
      geminiApiKey: env.GEMINI_API_KEY ?? '',
      /** Blank uses the public Gemini API. */
      geminiBaseUrl: env.GEMINI_BASE_URL ?? '',
      /** `low` | `medium` | `high` | `xhigh` | `max`, as Gemini's thinking level; the top three all mean `high`. */
      effort: parseEffort(env.ANALYST_EFFORT),
      /** Output ceiling per model turn, thinking included. Caps the cost of one runaway answer. */
      maxTokens: Number(env.ANALYST_MAX_TOKENS ?? 16_000),
      /**
       * Per model call. Long, because the Gemini free tier can take a minute
       * or two on even a tiny request. 5xx are retried up to `maxRetries`
       * times; a timeout is not.
       */
      timeoutMs: Number(env.ANALYST_TIMEOUT_MS ?? 240_000),
      maxRetries: Number(env.ANALYST_MAX_RETRIES ?? 2),
      /** Ceiling on one whole analysis, every turn and retry included. */
      deadlineMs: Number(env.ANALYST_DEADLINE_MS ?? 300_000),
      /**
       * Model calls per analysis. 1: the whole match goes in the first
       * message and the answer comes back in the same call. More lets the
       * model look details up again, at one quota request per turn.
       */
      maxTurns: limit(env.ANALYST_MAX_TURNS, 1),
      /** Fresh analyses per wallet per hour. Cached answers do not count. */
      quotaPerHour: Number(env.ANALYST_QUOTA_PER_HOUR ?? 3),
      /** Analyses being written at once, server-wide. One, so a single analysis has the whole per-minute quota. */
      maxConcurrent: Number(env.ANALYST_MAX_CONCURRENT ?? 1),
      /**
       * The Gemini project's own rate limits, enforced here so they are never
       * hit as errors. Defaults are the free tier for Gemini 3.8 Flash: 5
       * requests a minute, 20 a day. `none` lifts either.
       */
      requestsPerMinute: limit(env.ANALYST_RPM, 5),
      requestsPerDay: limit(env.ANALYST_RPD, 20),
      /**
       * Estimated spend per UTC day, in US dollars, after which fresh
       * analyses stop until midnight. `none` lifts the ceiling.
       */
      dailyBudgetUsd: env.ANALYST_DAILY_BUDGET_USD === 'none' ? Infinity : Number(env.ANALYST_DAILY_BUDGET_USD ?? 10),
    },
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

/** A positive whole-number limit, `none` for no limit, or the default when unset. */
function limit(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (value === 'none') return Infinity;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`expected a positive integer or "none", got "${value}"`);
  return parsed;
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
