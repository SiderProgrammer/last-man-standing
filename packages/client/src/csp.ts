import { DEFAULT_SERVER_PORT } from '../../protocol/src/ports.js';

/**
 * The Content-Security-Policy the production build ships with.
 *
 * The page holds a session key that can sign moves and, with one-click play,
 * stake from the player's account. Script injected into the page could use
 * it, so the policy allows no script but the bundle's own: no inline script,
 * no `eval`, and no markup from data (`test/csp.test.ts` keeps `innerHTML` out
 * of the source). Every origin the page may talk to is named, so an injected
 * script that did run could not send the key anywhere either.
 *
 * Built from the same environment the bundle is, because the servers it
 * talks to are configured there. A `<meta>` cannot set `frame-ancestors`; the
 * host serving the page should send `frame-ancestors 'none'` as a header.
 *
 * The dev server goes without: it injects styles as inline `<style>`
 * elements, which this policy refuses by design. A dev-mode build gets it,
 * with the burner's RPC added.
 */
export function contentSecurityPolicy(env: Record<string, string | undefined>, options: { dev?: boolean } = {}): string {
  const server = serverOrigins(env.VITE_WS_URL);
  // Only the dev burner reads an RPC from the page; production signs through
  // the wallet, which talks to its own node.
  const rpcs = options.dev
    ? [env.VITE_RPC_URL ?? DEV_RPC_URL, env.VITE_SPOKE_RPC_URL].flatMap((url) => (url ? [originOf(url)] : []))
    : [];
  // Where avatar images come from: the IPFS gateway the server rewrites to.
  const media = (env.VITE_CSP_MEDIA ?? 'https://ipfs.io').split(/\s+/).filter(Boolean);

  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'font-src': ["'self'"],
    // Pixi decodes textures in a worker it starts from a blob, and paints them.
    'img-src': ["'self'", 'data:', 'blob:', ...media],
    'worker-src': ["'self'", 'blob:'],
    // Pixi also `fetch`es `data:` and `blob:` URLs to decode images; neither
    // leaves the page, so they open no way out.
    'connect-src': ["'self'", 'data:', 'blob:', ...server, ...rpcs, ...media],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(' ')}`)
    .join('; ');
}

/** Where the dev burner signs through when `VITE_RPC_URL` is unset. */
export const DEV_RPC_URL = 'http://127.0.0.1:8545';

/**
 * The game server's socket and its HTTP side, which serves proposals and
 * transcripts. Unset, the client connects to its own host on the default
 * port, and that only happens in a local build.
 */
function serverOrigins(wsUrl: string | undefined): string[] {
  if (!wsUrl) {
    return ['localhost', '127.0.0.1'].flatMap((host) => [
      `ws://${host}:${DEFAULT_SERVER_PORT}`,
      `http://${host}:${DEFAULT_SERVER_PORT}`,
    ]);
  }
  const url = new URL(wsUrl);
  const http = url.protocol === 'wss:' ? 'https:' : 'http:';
  return [`${url.protocol}//${url.host}`, `${http}//${url.host}`];
}

function originOf(url: string): string {
  return new URL(url).origin;
}
