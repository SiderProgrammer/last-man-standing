import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string, entry = 'index.ts') =>
  fileURLToPath(new URL(`./packages/${name}/src/${entry}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lms/protocol': pkg('protocol'),
      // Before `@lms/engine`, which would otherwise claim these as its subpaths.
      '@lms/engine/bots': pkg('engine', 'bots/strategy.ts'),
      '@lms/engine/sim': pkg('engine', 'sim/simulate.ts'),
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
