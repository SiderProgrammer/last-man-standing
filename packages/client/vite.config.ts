import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { DEFAULT_SERVER_PORT } from '../protocol/src/ports.js';

/**
 * The client consumes `@lms/protocol` from source rather than from `dist`, so a
 * change to the wire format or the hashing rules shows up immediately instead of
 * after a rebuild. The commit hash in particular has to stay byte-identical with
 * the server and the contracts.
 */
export default defineConfig({
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
