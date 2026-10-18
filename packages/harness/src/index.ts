/**
 * Headless clients for exercising the game server: `BotClient` plays the real
 * wire protocol over any `Link`, `wsLink` connects one to a live server.
 * Used by `scripts/load-test.mjs` and by the chaos tests in `packages/server/test`.
 */
export { BotClient, type BotClientOptions, type BotEvent } from './botClient.js';
export { wsLink, type Link } from './link.js';
export { keyFor, mulberry32 } from './random.js';
