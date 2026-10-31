import { app, dom, store } from '../context.js';

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
  dom.navGovernance.onclick = () => showGovernance(true);
  dom.governanceBack.onclick = () => showGovernance(false);
  store.subscribe(['staking'], renderGovernanceNav);
}

/** The entry point is only offered when the server indexes a governor. */
export function renderGovernanceNav(): void {
  dom.navGovernance.classList.toggle('hidden', !app.staking?.governor || !dom.matchScreen.classList.contains('hidden'));
}

/** Redraws the screen if it is open; a closed one is drawn when it opens. */
export function refreshGovernance(): void {
  if (!dom.governanceScreen.classList.contains('hidden')) void load().then((module) => module.renderGovernance());
}

function showGovernance(show: boolean): void {
  dom.governanceScreen.classList.toggle('hidden', !show);
  dom.lobbyScreen.classList.toggle('hidden', show);
  dom.navGovernance.textContent = show ? 'Lobby' : 'Governance';
  dom.navGovernance.onclick = () => showGovernance(!show);
  refreshGovernance();
}
