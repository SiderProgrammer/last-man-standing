import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { DEFAULT_SERVER_PORT } from '../protocol/src/ports.js';
import { contentSecurityPolicy } from './src/csp.js';

/** Puts the production Content-Security-Policy in the page's `<head>`. See `src/csp.ts`. */
function csp(): Plugin {
  let policy = '';
  return {
    name: 'lms-csp',
    apply: 'build',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || config.root, 'VITE_');
      policy = contentSecurityPolicy(env, { dev: !config.isProduction });
    },
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  };
}

/**
 * The client consumes `@lms/protocol` from source rather than from `dist`, so a
 * change to the wire format or the hashing rules shows up immediately instead of
 * after a rebuild. The commit hash in particular has to stay byte-identical with
 * the server and the contracts.
 */
export default defineConfig({
  plugins: [csp()],
  resolve: {
    alias: {
      '@lms/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      // The in-browser verifier replays matches with the same kernel the server runs.
      '@lms/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/health': `http://localhost:${process.env.WS_PORT ?? DEFAULT_SERVER_PORT}`,
    },
  },
  build: {
    target: 'es2022',
  },
});
