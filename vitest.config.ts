import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lms/protocol': pkg('protocol'),
      '@lms/engine': pkg('engine'),
      '@lms/server': pkg('server'),
      '@lms/harness': pkg('harness'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // The engine's property and balance tests replay hundreds of
    // matches; run alongside each other they outlast the 5 s default.
    testTimeout: 30_000,
  },
});
