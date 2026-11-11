import { dom } from '../context.js';
import { resetGovernanceNav } from '../screens/governanceNav.js';

/** Page chrome shared by more than one screen. */

export function showMatchScreen(): void {
  dom.lobbyScreen.classList.add('hidden');
  dom.governanceScreen.classList.add('hidden');
  dom.navGovernance.classList.add('hidden');
  dom.matchScreen.classList.remove('hidden');
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string): void {
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 5_000);
}

export function showLobbyScreen(): void {
  dom.matchScreen.classList.add('hidden');
  dom.governanceScreen.classList.add('hidden');
  dom.lobbyScreen.classList.remove('hidden');
  // `showMatchScreen` hid the way into governance; the lobby offers it again.
  resetGovernanceNav();
}
