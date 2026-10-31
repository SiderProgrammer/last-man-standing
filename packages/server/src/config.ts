import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import * as z from 'zod/v4';
import { DEFAULT_SERVER_PORT, ZERO_ADDRESS } from '@lms/protocol';

export type ServerConfig = ReturnType<typeof loadConfig>;

/** A malformed environment, with every problem listed, one per line. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Blank counts as unset: `.env.example` ships with empty values.
const variable = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const whole = (fallback: number, min = 0) =>
  variable(
    z
      .string()
      .regex(/^\d+$/, 'must be a whole number')
      .default(String(fallback))
      .transform(Number)
      .pipe(z.number().min(min, `must be at least ${min}`).max(Number.MAX_SAFE_INTEGER, 'is too large')),
  );

const bigint = variable(
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform((value) => BigInt(value))
    .optional(),
);

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((value) => value as `0x${string}`);

/** Unset falls back to the deployment registry, then to the zero address. */
const address = variable(hexAddress.optional());

const privateKey = variable(
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key')
    .transform((value) => value as `0x${string}`)
    .optional(),
);

const url = (protocol: RegExp, what: string) =>
  variable(z.url({ protocol, error: `must be ${what} URL` }).optional());
const text = (fallback = '') => variable(z.string().default(fallback));
const json = variable(
  z
    .string()
    .refine((value) => {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }, 'must be valid JSON')
    .default(''),
);

const flag = (fallback: boolean) =>
  variable(
    z
      .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true' || value === '1'),
  );

/** A positive whole-number limit, `none` for no limit. */
const limit = (fallback: number) =>
  variable(
    z
      .string()
      .regex(/^(none|[1-9]\d*)$/, 'must be a positive integer or "none"')
      .default(String(fallback))
      .transform((value) => (value === 'none' ? Infinity : Number(value))),
  );

/** A non-negative amount, `none` for no ceiling. */
const ceiling = (fallback: number) =>
  variable(
    z
      .string()
      .regex(/^(none|\d+(\.\d+)?)$/, 'must be a non-negative number or "none"')
      .default(String(fallback))
      .transform((value) => (value === 'none' ? Infinity : Number(value))),
  );

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Every variable the server reads, with its default. Anything else in the environment is ignored. */
const ENV = z.object({
  NODE_ENV: text(),
  WS_PORT: whole(DEFAULT_SERVER_PORT, 1),
  CHAIN_ID: whole(84532, 1),
  COMMIT_MS: whole(20_000, 1),
  REVEAL_MS: whole(12_000, 1),
  REPLAY_MS: whole(2_500),
  RPC_URL: url(/^(https?|wss?)$/, 'an http(s) or ws(s)'),
  ESCROW_ADDRESS: address,
  ATTESTOR_PK: privateKey,
  KEEPER_PK: privateKey,
  DATABASE_URL: url(/^postgres(ql)?$/, 'a postgres://'),
  ARCHIVE: variable(z.enum(['postgres', 'memory'], { error: 'must be postgres or memory' }).optional()),
  MAX_PRACTICE_ROOMS: whole(200),
  MAX_CONNECTIONS: whole(10_000, 1),
  MAX_CONNECTIONS_PER_IP: whole(20, 1),
  LOGIN_TIMEOUT_MS: whole(120_000, 1),
  ALLOWED_ORIGINS: text(),
  TRUST_PROXY: flag(false),
  GATEWAY_LIMITS: json,
  VERIFY_THREADS: whole(Math.max(1, Math.min(4, availableParallelism() - 1))),
  AVATAR_COLLECTIONS: text(),
  IPFS_GATEWAY: text('https://ipfs.io/ipfs/'),
  SESSION_DELEGATE: address,
  SESSION_RELAYER_PK: privateKey,
  MATCHMAKER_PK: privateKey,
  MATCHMAKING_TIERS: text(
    JSON.stringify([
      { stake: '1000000000000000', seats: 4 },
      { stake: '1000000000000000', seats: 8 },
      { stake: '10000000000000000', seats: 4 },
    ]),
  ),
  MATCHMAKING_FILL_AFTER_MS: whole(30_000),
  RELAY_QUOTA_PER_DAY: whole(20),
  SPOKES: text(),
  CROSS_CHAIN_FROM_BLOCK: bigint,
  CONFIRMATIONS: whole(3),
  ZAP_JOIN: address,
  V4_QUOTER: address,
  ZAP_TOKENS: text(),
  FEE_ROUTER: address,
  FEE_KEEPER_POLL_MS: whole(60_000, 1),
  HARVEST_MIN_WEI: bigint,
  STAKED_LMS: address,
  REWARDS_DISTRIBUTOR: address,
  GOVERNOR_ADDRESS: address,
  GOVERNOR_FROM_BLOCK: bigint,
  ANALYST_ENABLED: flag(true),
  ANALYST_MODEL: text('gemini-3.8-flash'),
  GEMINI_API_KEY: text(),
  GEMINI_BASE_URL: text(),
  ANALYST_EFFORT: variable(z.enum(EFFORTS, { error: `must be one of ${EFFORTS.join(', ')}` }).default('medium')),
  ANALYST_MAX_TOKENS: whole(16_000, 1),
  ANALYST_TIMEOUT_MS: whole(240_000, 1),
  ANALYST_MAX_RETRIES: whole(2),
  ANALYST_DEADLINE_MS: whole(300_000, 1),
  ANALYST_MAX_TURNS: limit(1),
  ANALYST_QUOTA_PER_HOUR: whole(3),
  ANALYST_MAX_CONCURRENT: whole(1, 1),
  ANALYST_RPM: limit(5),
  ANALYST_RPD: limit(20),
  ANALYST_DAILY_BUDGET_USD: ceiling(10),
});

/**
 * Reads the server's configuration out of an environment, and refuses a
 * malformed one: a non-numeric duration, an address that is not one, or a
 * production server with no database. Every problem is reported at once, so
 * fixing a `.env` takes one restart, not one per typo.
 *
 * Taking `env` as an argument rather than reaching for `process.env` directly
 * is what makes this testable.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  deployments: (chainId: number) => Deployment | null = () => null,
) {
  const result = ENV.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      `invalid server configuration:\n${result.error.issues.map((issue) => `  ${issue.path.join('.')} ${issue.message}`).join('\n')}`,
    );
  }
  const e = result.data;
  const deployment = deployments(e.CHAIN_ID);
  const deployed = (name: string): `0x${string}` => deployment?.contracts[name] ?? ZERO_ADDRESS;
  const fromBlock = deployment ? BigInt(deployment.deployBlock) : undefined;
  if (e.NODE_ENV === 'production' && !e.DATABASE_URL && e.ARCHIVE !== 'memory') {
    throw new ConfigError(
      'invalid server configuration:\n  DATABASE_URL is required in production; set ARCHIVE=memory to run without one',
    );
  }
  // A session grant names the page that asked for it, and a page on another
  // origin could otherwise ask a player's wallet for one this server honours.
  if (e.NODE_ENV === 'production' && !e.ALLOWED_ORIGINS.trim()) {
    throw new ConfigError(
      'invalid server configuration:\n  ALLOWED_ORIGINS is required in production; set ALLOWED_ORIGINS=* to accept any origin',
    );
  }
  // One key per job, as `Deploy.s.sol` gives every role its own address: a
  // drained relayer must not stop settlement, and a leaked keeper key must
  // not sign results.
  const keys = Object.entries({
    ATTESTOR_PK: e.ATTESTOR_PK,
    KEEPER_PK: e.KEEPER_PK,
    SESSION_RELAYER_PK: e.SESSION_RELAYER_PK,
    MATCHMAKER_PK: e.MATCHMAKER_PK,
  }).flatMap(([name, key]) => (key ? [[name, key.toLowerCase()] as const] : []));
  const shared = keys.filter(([, key], i) => keys.some(([, other], j) => j !== i && other === key));
  if (shared.length > 0) {
    throw new ConfigError(
      `invalid server configuration:\n  ${shared.map(([name]) => name).join(', ')} are the same key; each job needs its own`,
    );
  }
  if (e.ARCHIVE === 'postgres' && !e.DATABASE_URL) {
    throw new ConfigError('invalid server configuration:\n  ARCHIVE=postgres needs DATABASE_URL');
  }

  return {
    port: e.WS_PORT,
    chainId: e.CHAIN_ID,
    commitMs: e.COMMIT_MS,
    revealMs: e.REVEAL_MS,
    /** Hold after each round so clients can replay it before the next clock starts. */
    replayMs: e.REPLAY_MS,
    rpcUrl: e.RPC_URL ?? '',
    escrow: e.ESCROW_ADDRESS ?? deployed('escrow'),
    /**
     * Signs results, aborts and commit receipts, in a process of its own
     * (`attestor/process.ts`). Never sends a transaction.
     */
    attestorPk: e.ATTESTOR_PK,
    /**
     * Sends every transaction that needs no authority: lock, finalise,
     * cancel, harvest, and the attestor's signed settle and abort. Without
     * it, nothing reaches the chain from here.
     */
    keeperPk: e.KEEPER_PK,
    /** Opens matchmade lobbies with their rosters. See `lobby/matchmaker.ts`. */
    matchmakerPk: e.MATCHMAKER_PK,
    /**
     * The queues the matchmaker runs, as JSON: `[{"stake":"<wei>","seats":4}]`.
     * Each stake must be one the escrow accepts. Only with `MATCHMAKER_PK`.
     */
    matchmakingTiers: e.MATCHMAKING_TIERS,
    /** A tier with enough players for a table, but not a full one, opens it after the first has waited this long. */
    matchmakingFillAfterMs: e.MATCHMAKING_FILL_AFTER_MS,
    /** Blank, or `ARCHIVE=memory`, keeps the archive in memory. */
    databaseUrl: e.ARCHIVE === 'memory' ? '' : (e.DATABASE_URL ?? ''),
    /** Ceiling on practice rooms across all wallets; each wallet holds at most one. */
    maxPracticeRooms: e.MAX_PRACTICE_ROOMS,
    /** Sockets open at once, across the server and per client IP. See `gateway/limits.ts`. */
    maxConnections: e.MAX_CONNECTIONS,
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    /** A socket that has not logged in by then is closed. */
    loginTimeoutMs: e.LOGIN_TIMEOUT_MS,
    /**
     * Comma-separated `Origin`s the WebSocket handshake accepts, e.g.
     * `https://play.example.com`. The same list bounds the origin a session
     * grant may name. Blank accepts any origin, which is what local
     * development wants; production refuses to start without it, and `*`
     * says any origin is intended.
     */
    allowedOrigins: e.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin && origin !== '*'),
    /**
     * Take the client IP from `X-Forwarded-For` instead of the socket. Only
     * behind a proxy that sets it: otherwise any client can claim any IP and
     * walk straight past the per-IP limits.
     */
    trustProxy: e.TRUST_PROXY,
    /**
     * Overrides for any field of `DEFAULT_GATEWAY_LIMITS`, as JSON, e.g.
     * `{"connectRatePerIp":1000,"connectBurstPerIp":10000}` for a load test
     * whose clients all come from one IP. Unknown or non-numeric fields are
     * ignored.
     */
    gatewayLimits: parseLimits(e.GATEWAY_LIMITS),
    /**
     * Worker threads that recover login signatures off the event loop. Zero
     * recovers inline. The default leaves one core for the event loop.
     */
    verifyThreads: e.VERIFY_THREADS,
    /**
     * `PlayerAvatars` deployments, as JSON:
     * `[{"chainId":11155111,"address":"0x…","rpcUrl":"https://…"}]`
     *
     * One entry per chain players mint on, because the collection is deployed
     * per chain rather than bridged. Reading a spoke's collection needs that
     * spoke's RPC, which is why the URL travels with the address.
     */
    avatarCollections: e.AVATAR_COLLECTIONS,
    /** Prefix `ipfs://` is rewritten to when fetching avatar metadata. */
    ipfsGateway: e.IPFS_GATEWAY,
    /**
     * `SessionKeyDelegate` on the hub chain. A burner or embedded wallet
     * delegates to it under EIP-7702 and grants its browser key a capped
     * session; the server then relays that key's joins and withdrawals. See
     * `chain/sessionRelay.ts`.
     */
    sessionDelegate: e.SESSION_DELEGATE ?? deployed('sessionDelegate'),
    /** Pays relayed gas. Unset, the server relays nothing and offers no one-click play. */
    sessionRelayerPk: e.SESSION_RELAYER_PK,
    /** Relayed calls per wallet per UTC day. */
    relayQuotaPerDay: e.RELAY_QUOTA_PER_DAY,
    /**
     * Spoke chains players may stake from, as JSON:
     * `[{"chainId":42161,"router":"0x…"}]`, one `SpokeRouter` per chain, from
     * that chain's `deployments/<chainId>.json`. Blank offers hub-only staking.
     * See `chain/crossChain.ts`.
     */
    spokes: e.SPOKES,
    /** The escrow's deploy block, from the registry: no scan of its events starts before it. */
    escrowFromBlock: fromBlock,
    /**
     * Blocks behind the head every log scan stops at. Base's sequencer can
     * still reorg its newest blocks; three is six seconds of them.
     */
    confirmations: e.CONFIRMATIONS,
    /** First block to look for cross-chain events in. Blank starts a short way behind the head. */
    crossChainFromBlock: e.CROSS_CHAIN_FROM_BLOCK ?? fromBlock,
    /** `ZapJoin` on the hub chain. Blank disables paying in tokens; ETH still works. */
    zapJoin: e.ZAP_JOIN ?? deployed('zapJoin'),
    /** v4-periphery `V4Quoter` on the hub chain, which the client prices routes with. */
    v4Quoter: e.V4_QUOTER ?? ZERO_ADDRESS,
    /** Tokens offered through the zap, each with its v4 route to ETH, as JSON. See `chain/zap.ts`. */
    zapTokens: e.ZAP_TOKENS,
    /**
     * `FeeRouter` on the hub chain. With `KEEPER_PK` set, the server harvests
     * it on a timer so fees reach stakers. Blank disables it; anyone else can
     * still harvest. See `chain/feeKeeper.ts`.
     */
    feeRouter: e.FEE_ROUTER ?? deployed('feeRouter'),
    feeKeeperPollMs: e.FEE_KEEPER_POLL_MS,
    /** Overrides for `DEFAULT_FEE_KEEPER_POLICY`, in wei. Unset keeps the default. */
    feeKeeper: {
      minHarvest: e.HARVEST_MIN_WEI,
    },
    /** `StakedLms` on the hub chain. Blank hides the staking panel. */
    stakedLms: e.STAKED_LMS ?? deployed('stakedLms'),
    /** `RewardsDistributor` on the hub chain. Blank hides the play-mining claim. */
    rewardsDistributor: e.REWARDS_DISTRIBUTOR ?? deployed('rewardsDistributor'),
    /** `LmsGovernor` on the hub chain. Blank hides the governance screen. */
    governor: e.GOVERNOR_ADDRESS ?? deployed('governor'),
    /** First block to look for proposals in: the governor's deployment block. */
    governorFromBlock: e.GOVERNOR_FROM_BLOCK ?? fromBlock ?? 0n,
    /**
     * Post-match analysis with Gemini. On when `GEMINI_API_KEY` is set;
     * `ANALYST_ENABLED=false` forces it off. Off, the client shows the panel
     * as unavailable and nothing is ever sent anywhere.
     */
    analyst: {
      enabled: e.ANALYST_ENABLED && Boolean(e.GEMINI_API_KEY),
      /** A Gemini 3 model or later: the first to combine structured output with function calling. */
      model: e.ANALYST_MODEL,
      geminiApiKey: e.GEMINI_API_KEY,
      /** Blank uses the public Gemini API. */
      geminiBaseUrl: e.GEMINI_BASE_URL,
      /** `low` | `medium` | `high` | `xhigh` | `max`, as Gemini's thinking level; the top three all mean `high`. */
      effort: e.ANALYST_EFFORT,
      /** Output ceiling per model turn, thinking included. Caps the cost of one runaway answer. */
      maxTokens: e.ANALYST_MAX_TOKENS,
      /**
       * Per model call. Long, because the Gemini free tier can take a minute
       * or two on even a tiny request. 5xx are retried up to `maxRetries`
       * times; a timeout is not.
       */
      timeoutMs: e.ANALYST_TIMEOUT_MS,
      maxRetries: e.ANALYST_MAX_RETRIES,
      /** Ceiling on one whole analysis, every turn and retry included. */
      deadlineMs: e.ANALYST_DEADLINE_MS,
      /**
       * Model calls per analysis. 1: the whole match goes in the first
       * message and the answer comes back in the same call. More lets the
       * model look details up again, at one quota request per turn.
       */
      maxTurns: e.ANALYST_MAX_TURNS,
      /** Fresh analyses per wallet per hour. Cached answers do not count. */
      quotaPerHour: e.ANALYST_QUOTA_PER_HOUR,
      /** Analyses being written at once, server-wide. One, so a single analysis has the whole per-minute quota. */
      maxConcurrent: e.ANALYST_MAX_CONCURRENT,
      /**
       * The Gemini project's own rate limits, enforced here so they are never
       * hit as errors. Defaults are the free tier for Gemini 3.8 Flash: 5
       * requests a minute, 20 a day. `none` lifts either.
       */
      requestsPerMinute: e.ANALYST_RPM,
      requestsPerDay: e.ANALYST_RPD,
      /**
       * Estimated spend per UTC day, in US dollars, after which fresh
       * analyses stop until midnight. `none` lifts the ceiling.
       */
      dailyBudgetUsd: e.ANALYST_DAILY_BUDGET_USD,
    },
    /** True once an escrow is configured and the chain bridge can run. */
    get onChain(): boolean {
      return Boolean(this.rpcUrl) && this.escrow !== ZERO_ADDRESS;
    },
  };
}

/** Numeric fields of a JSON object; anything else is dropped. */
function parseLimits(raw: string): Record<string, number> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
  );
}

/** `contracts/deployments/<chainId>.json`, as `Deploy.s.sol` writes it. */
export interface Deployment {
  chainId: number;
  /** No contract in `contracts` is older: where log scans start. */
  deployBlock: number;
  contracts: Record<string, `0x${string}`>;
}

const DEPLOYMENT = z.object({
  chainId: z.number().int(),
  deployBlock: z.number().int().min(0),
  contracts: z.record(z.string(), hexAddress),
});

const DEPLOYMENTS_DIR = new URL('../../../contracts/deployments/', import.meta.url);

/**
 * The registry the deploy script wrote for `chainId`, or null if there is
 * none. Throws on a file that is there but malformed, or names another chain.
 */
export function readDeployment(chainId: number, dir: URL = DEPLOYMENTS_DIR): Deployment | null {
  const file = new URL(`${chainId}.json`, dir);
  if (!existsSync(file)) return null;
  const result = DEPLOYMENT.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!result.success) throw new ConfigError(`invalid deployment registry ${file.pathname}: ${result.error.message}`);
  if (result.data.chainId !== chainId) {
    throw new ConfigError(`deployment registry ${file.pathname} is for chain ${result.data.chainId}, not ${chainId}`);
  }
  return result.data;
}

export const config = loadConfig(process.env, readDeployment);

export { ZERO_ADDRESS };
