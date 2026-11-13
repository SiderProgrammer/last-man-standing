import { dom, store } from '../context.js';
import { renderNav, showScreen } from '../ui/chrome.js';
import { leaveMatchFor } from './match.js';

/**
 * The way into the governance screen, which is not part of the main bundle:
 * the screen, the proposal form and the governor's ABIs load the first time
 * a player opens it.
 */

type Screen = typeof import('./governance.js');

let serverOrigin = '';
let screen: Promise<Screen> | null = null;

function load(): Promise<Screen> {
  screen ??= import('./governance.js').then((module) => {
    module.wireGovernanceControls(serverOrigin);
    return module;
  });
  return screen;
}

export function wireGovernanceNav(origin: string): void {
  serverOrigin = origin;
  dom.navGovernance.onclick = () => {
    if (!leaveMatchFor()) return;
    showScreen('governance');
    refreshGovernance();
  };
  dom.governanceBack.onclick = () => showScreen('lobby');
  // The entry point is only offered when the server indexes a governor.
  store.subscribe(['staking'], renderNav);
  // A login, or a switch to or from the hub, changes what the screen can read.
  store.subscribe(['wallet', 'walletChainId'], refreshGovernance);
}

/** Redraws the screen if it is open; a closed one is drawn when it opens. */
export function refreshGovernance(): void {
  if (!dom.governanceScreen.classList.contains('hidden')) void load().then((module) => module.renderGovernance());
}
