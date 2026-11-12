import { app, dom } from '../context.js';
import { element } from './dom.js';

/** Page chrome shared by more than one screen: which screen is up, the header, toasts. */

export type ScreenName = 'lobby' | 'match' | 'governance' | 'account';

let current: ScreenName = 'lobby';

export function currentScreen(): ScreenName {
  return current;
}

/** Shows one screen and hides the rest. A new screen starts at the top of the page. */
export function showScreen(name: ScreenName): void {
  const screens: Record<ScreenName, HTMLElement> = {
    lobby: dom.lobbyScreen,
    match: dom.matchScreen,
    governance: dom.governanceScreen,
    account: dom.accountScreen,
  };
  for (const [key, screen] of Object.entries(screens)) screen.classList.toggle('hidden', key !== name);
  // The lobby's scroll position must not carry over: the arena would open
  // half off-screen.
  if (current !== name) window.scrollTo({ top: 0 });
  current = name;
  closeMenu();
  renderNav();
}

export function showMatchScreen(): void {
  showScreen('match');
}

export function showLobbyScreen(): void {
  showScreen('lobby');
}

/**
 * The header's way between screens. During a match it offers nothing that
 * leaves the table: a seat that wanders off misses its rounds.
 */
export function renderNav(): void {
  dom.navLobby.classList.toggle('hidden', current === 'lobby' || current === 'match');
  dom.navGovernance.classList.toggle('hidden', !app.staking?.governor || current === 'match' || current === 'governance');
}

// ---------------------------------------------------------------- phone menu

function closeMenu(): void {
  document.body.classList.remove('menu-open');
  dom.navMenu.setAttribute('aria-expanded', 'false');
}

export function wireChrome(): void {
  dom.navMenu.onclick = () => {
    const open = !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    dom.navMenu.setAttribute('aria-expanded', String(open));
  };
  dom.navLobby.onclick = () => showScreen('lobby');
  // Picking anything in the menu closes it.
  dom.topbarNav.addEventListener('click', (event) => {
    if (event.target instanceof HTMLButtonElement) closeMenu();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clearAlert();
  });
  renderNav();
}

// -------------------------------------------------------------------- toasts

export type ToastKind = 'info' | 'success' | 'error';

/** How long a toast stays, by kind; a sticky one stays until it is dismissed. */
const TOAST_MS: Record<ToastKind, number> = { info: 6_000, success: 5_000, error: 9_000 };
/** More than this on screen and the oldest goes. */
const MAX_TOASTS = 4;

/**
 * Shows a message in the stack at the bottom of the page. Each has a colour
 * for its kind and a close button; a sticky one (matched, not seated,
 * refunded) waits to be dismissed. The stack is a `role="status"` region,
 * so screen readers announce each one.
 */
export function toast(message: string, kind: ToastKind = 'info', options: { sticky?: boolean } = {}): void {
  const item = element('div', `toast ${kind}`);
  const close = element('button', 'toast-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => item.remove();
  item.append(element('span', 'toast-text', message), close);
  dom.toast.append(item);
  while (dom.toast.children.length > MAX_TOASTS) dom.toast.firstElementChild?.remove();
  if (!options.sticky) setTimeout(() => item.remove(), TOAST_MS[kind]);
}

// ------------------------------------------------------- background alerts

/** The title to put back when the player returns, or null while none is flagged. */
let savedTitle: string | null = null;

/**
 * Flags something that wants the player back while the tab is in the
 * background: the title shows it until they return.
 */
export function alertInBackground(text: string): void {
  if (!document.hidden) return;
  savedTitle ??= document.title;
  document.title = `● ${text} · ${savedTitle}`;
}

function clearAlert(): void {
  if (savedTitle === null) return;
  document.title = savedTitle;
  savedTitle = null;
}
