import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { DEFAULT_SERVER_PORT } from '../api/src/ports.js';
import { contentSecurityPolicy } from './src/csp.js';
import { filesWithDevKeys } from './src/devKeys.js';

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

/** Fails a production build that has a dev burner key in it. See `src/devKeys.ts`. */
function noDevKeys(): Plugin {
  let env: Record<string, string> = {};
  let production = false;
  return {
    name: 'lms-no-dev-keys',
    apply: 'build',
    configResolved(config) {
      env = loadEnv(config.mode, config.envDir || config.root, 'VITE_');
      production = config.isProduction;
    },
    generateBundle(_options, bundle) {
      if (!production) return;
      const files = Object.values(bundle).map((file) => ({
        name: file.fileName,
        text: file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : '',
      }));
      const leaks = filesWithDevKeys(env, files);
      if (leaks.length) this.error(`VITE_DEV_KEY or VITE_DEV_KEYS is in the production bundle: ${leaks.join(', ')}`);
    },
  };
}

/**
 * The client consumes the shared packages from source rather than from `dist`,
 * so a change to the wire format or the hashing rules shows up immediately
 * instead of after a rebuild. The commit hash in particular has to stay byte-identical with
 * the server and the contracts.
 */
export default defineConfig({
  plugins: [csp(), noDevKeys()],
  resolve: {
    alias: {
      '@lms/consensus': fileURLToPath(new URL('../consensus/src/index.ts', import.meta.url)),
      '@lms/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
      '@lms/api': fileURLToPath(new URL('../api/src/index.ts', import.meta.url)),
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
