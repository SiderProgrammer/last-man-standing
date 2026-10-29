/**
 * Port the game server listens on unless `WS_PORT` says otherwise. The server's
 * config, the client's default URL and the dev proxy all read it from here;
 * `.claude/launch.json` and `.env.example` are JSON and env text and repeat it.
 */
export const DEFAULT_SERVER_PORT = 8787;
