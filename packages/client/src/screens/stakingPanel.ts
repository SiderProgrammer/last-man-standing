import { app, store } from '../context.js';

/**
 * The staking panel is not part of the main bundle: it, the vault's and the
 * distributor's ABIs load once the server's `hello` names a vault, and never
 * on a server that has none.
 */

type Panel = typeof import('./staking.js');

let panel: Promise<Panel> | null = null;

export function wireStakingPanel(): void {
  store.subscribe(['staking'], () => {
    if (!app.staking || panel) return;
    panel = import('./staking.js').then((module) => {
      // Subscribes it to what it draws from now on; this first draw catches up.
      module.wireStakingControls();
      void module.renderStakingPanel();
      return module;
    });
  });
}

/** Reads the position again, if the panel is loaded: after a login, and on a timer for the countdowns. */
export function refreshStaking(): void {
  if (app.wallet) void panel?.then((module) => module.renderStakingPanel());
}
