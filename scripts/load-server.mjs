#!/usr/bin/env node
/**
 * Starts the built game server with limits opened up for a load test, where
 * every client comes from the generator's one IP. Never use this profile in
 * production: it switches off the per-IP protections on purpose.
 *
 *   npm run build && node scripts/load-server.mjs      ws://localhost:8789
 *
 * Anything already set in the environment wins over these defaults.
 */
const UNLIMITED = 1_000_000;

const defaults = {
  WS_PORT: '8789',
  NODE_ENV: 'production',
  // A load test keeps nothing; production otherwise requires DATABASE_URL.
  ARCHIVE: 'memory',
  // The generator's sockets send no Origin; production otherwise requires a list.
  ALLOWED_ORIGINS: '*',
  MAX_CONNECTIONS: String(UNLIMITED),
  MAX_CONNECTIONS_PER_IP: String(UNLIMITED),
  MAX_PRACTICE_ROOMS: String(UNLIMITED),
  GATEWAY_LIMITS: JSON.stringify({
    connectRatePerIp: UNLIMITED,
    connectBurstPerIp: UNLIMITED,
    loginRatePerIp: UNLIMITED,
    loginBurstPerIp: UNLIMITED,
  }),
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

await import('../packages/server/dist/main.js');
