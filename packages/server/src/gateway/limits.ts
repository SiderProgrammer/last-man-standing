/**
 * Rate-limiting primitives and the gateway's limits.
 *
 * Everything here takes the clock as an argument rather than reading it, for
 * the same reason the room does: tests drive time, production passes
 * `Date.now()`.
 */

/** Refills at `rate` tokens per second up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private refilledAt: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.refilledAt = now;
  }

  /** Takes `cost` tokens. False, and nothing taken, when there are not enough. */
  take(now: number, cost = 1): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Returns `cost` tokens, up to the burst. */
  give(now: number, cost = 1): void {
    this.refill(now);
    this.tokens = Math.min(this.burst, this.tokens + cost);
  }

  /** True once the bucket has refilled completely, which is when it can be forgotten. */
  full(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.burst;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rate) / 1000);
    this.refilledAt = now;
  }
}

/**
 * One bucket per key — an IP, a wallet — shared across connections.
 *
 * A full bucket carries no information, so it is dropped on the next sweep;
 * without that, a stream of fresh keys would grow the map without bound. The
 * hard `maxKeys` ceiling covers a flood faster than the sweep: past it, an
 * unknown key is refused outright, which fails closed for new keys and leaves
 * every key already being tracked unaffected.
 */
export class KeyedLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly maxKeys = 100_000,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  take(key: string, now: number, cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) return false;
      bucket = new TokenBucket(this.rate, this.burst, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now, cost);
  }

  /**
   * Hands back tokens taken for work that then failed through no fault of
   * the key's owner. Never above the burst, and a no-op for a key no longer
   * tracked, which is already full.
   */
  refund(key: string, now: number, cost = 1): void {
    this.buckets.get(key)?.give(now, cost);
  }

  /** Forgets every key whose bucket has refilled. */
  sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.full(now)) this.buckets.delete(key);
    }
  }
}

/**
 * What the gateway allows. Every field has a default in
 * `DEFAULT_GATEWAY_LIMITS`; `main.ts` overrides the ones operators tune.
 */
export interface GatewayLimits {
  /** Sockets open at once across the server. */
  maxConnections: number;
  /** Sockets open at once from one IP. Generous enough for a household behind NAT. */
  maxConnectionsPerIp: number;
  /** New sockets per second from one IP, and the burst allowed above it. */
  connectRatePerIp: number;
  connectBurstPerIp: number;
  /** `Origin` headers accepted at the handshake. Empty accepts any, including none. */
  allowedOrigins: readonly string[];
  /**
   * A socket that has not logged in by then is closed, which is also when its
   * nonce expires. Generous, because the page opens its socket on load and a
   * visitor may read for a while before connecting a wallet; a close in the
   * middle of a wallet prompt would make them sign twice.
   */
  loginTimeoutMs: number;
  /** Failed logins one socket may make before it is closed. */
  maxLoginFailures: number;
  /**
   * Login attempts per second from one IP. A session-key login costs the
   * server an ERC-1271 RPC call, so this caps what a stranger can spend of the
   * RPC quota without ever holding a wallet.
   */
  loginRatePerIp: number;
  loginBurstPerIp: number;
  /** General messages per second per socket, and the burst above it. */
  messageRate: number;
  messageBurst: number;
  /**
   * Commits and reveals have a bucket of their own, so flooding `lobbies` can
   * never leave a player unable to reveal. A round needs two; this allows
   * plenty of retries and still caps a loop.
   */
  moveRate: number;
  moveBurst: number;
  /**
   * Relayed calls per second per *wallet*, across every socket it logs in on.
   * Each one spends the relayer's gas, so it is the tightest budget here.
   */
  relayRatePerWallet: number;
  relayBurstPerWallet: number;
  /**
   * Misbehaviour — malformed frames, rate-limited frames, failed logins —
   * drains this bucket; an empty one closes the socket. Refills slowly, so a
   * client with one bad frame a minute is never punished.
   */
  strikeRate: number;
  strikeBurst: number;
  /**
   * Bytes queued on a socket the client is not reading. Past it the client
   * is closed rather than letting its backlog grow in server memory.
   */
  maxBufferedBytes: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  maxConnections: 10_000,
  maxConnectionsPerIp: 20,
  connectRatePerIp: 2,
  connectBurstPerIp: 10,
  allowedOrigins: [],
  loginTimeoutMs: 120_000,
  maxLoginFailures: 5,
  loginRatePerIp: 2,
  loginBurstPerIp: 10,
  messageRate: 10,
  messageBurst: 30,
  moveRate: 4,
  moveBurst: 12,
  relayRatePerWallet: 0.2,
  relayBurstPerWallet: 5,
  strikeRate: 0.1,
  strikeBurst: 20,
  maxBufferedBytes: 1024 * 1024,
};

/** WebSocket close codes the gateway uses. */
export const CloseCode = {
  /** RFC 6455 1008: the client broke the rules. */
  PolicyViolation: 1008,
  /** RFC 6455 1013: the server is full; the client may retry later. */
  TryAgainLater: 1013,
} as const;
