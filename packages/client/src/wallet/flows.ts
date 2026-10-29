import {
  AUTH_PREFIX,
  chainInfo,
  errorFirstLine,
  type AvatarCollectionInfo,
} from '@lms/protocol';
import { app, dom, net } from '../context.js';
import { toast } from '../ui/chrome.js';
import { avatarPanel, hubLabel, type AvatarStatus } from '../ui/views.js';
import { renderPayWith } from '../screens/lobby.js';
import { Session } from './session.js';
import { Wallet } from './wallet.js';

/**
 * Everything the player does with their wallet: connecting, logging in, the
 * session key that makes later logins prompt-free, and the avatar and
 * hub-chain panels that depend on which chain the wallet is on.
 */

export function wireWalletControls(): void {
  dom.connect.onclick = () => void connectWallet();
  dom.mintAvatar.onclick = () => void mintAvatar();
  dom.enableSession.onclick = () => void enableSession();
  dom.revokeSession.onclick = () => void revokeSession();
}

async function connectWallet(): Promise<void> {
  try {
    const devKey = import.meta.env.DEV ? import.meta.env.VITE_DEV_KEY : undefined;
    app.wallet =
      Wallet.available() || !devKey
        ? await Wallet.connect()
        : await Wallet.burner(devKey as `0x${string}`, burnerRpc());
    restoreSession();
    renderHubLabel();
    // The lobby's buttons depend on which chain the wallet turned out to be on.
    renderPayWith();
    renderSessionPanel();
    void renderAvatarPanel();
    await authenticate();
  } catch (error) {
    console.error('[wallet]', error);
    toast(errorFirstLine(error));
  }
}

/** True from sending a session-key login until the server answers it. */
let sessionLoginPending = false;

/**
 * The node the dev burner signs through. `?chain=spoke` puts it on the spoke
 * that `npm run dev:fork` runs, so a join from a spoke can be tried without a
 * wallet extension; anything else is the hub.
 */
function burnerRpc(): string | undefined {
  const spoke = new URLSearchParams(location.search).get('chain') === 'spoke';
  return spoke && import.meta.env.VITE_SPOKE_RPC_URL ? import.meta.env.VITE_SPOKE_RPC_URL : import.meta.env.VITE_RPC_URL;
}

export async function authenticate(): Promise<void> {
  const wallet = app.wallet;
  if (!wallet || !app.nonce) return;

  const message = `${AUTH_PREFIX}${app.nonce}`;
  try {
    // The session key is the whole point of the delegation: reconnects are
    // routine, and each one would otherwise interrupt the player mid-round.
    const signature = app.session
      ? await app.session.signLogin(message)
      : await wallet.signLogin(app.nonce);
    sessionLoginPending = app.session !== null;
    net.send({ type: 'auth', address: wallet.address, signature });
  } catch (error) {
    console.error('[auth]', error);
    if (app.session) {
      dropSession();
      return;
    }
    toast(`Login signature failed: ${errorFirstLine(error)}`);
  }
}

export function onAuthed(): void {
  sessionLoginPending = false;
}

/**
 * Called when the server refuses a login signature. During a session-key login
 * that means the server no longer accepts the key: the account was
 * re-delegated, the key revoked, or the chain behind it reset (a redeployed
 * fork puts the delegate at the same address, so `Session.load` cannot tell).
 * Returns true when it handled the error by retrying with the wallet.
 */
export function onLoginRejected(): boolean {
  if (!sessionLoginPending) return false;
  sessionLoginPending = false;
  dropSession();
  void authenticate();
  return true;
}

/** A key the chain no longer honours is worse than none: drop it so logins go through the wallet. */
function dropSession(): void {
  const wallet = app.wallet;
  app.session = null;
  if (wallet) Session.forget(wallet.address, wallet.chainId);
  renderSessionPanel();
  toast('Session key rejected — falling back to your wallet.');
}

/**
 * The hub chain, plus a warning when the connected wallet is pointed somewhere
 * else. A player on the wrong network can read every lobby but every stake they
 * try to place reverts, and the wallet's own error for that is unreadable.
 */
export function renderHubLabel(): void {
  const label = hubLabel(app.chainId, app.wallet?.chainId ?? 0, Boolean(app.escrow), app.spokes);

  dom.chainLabel.style.setProperty('--chain', label.css);
  dom.chainLabel.classList.add('chain-chip');
  dom.chainLabel.classList.toggle('warn', label.mismatch);
  dom.chainLabel.textContent = label.text;
  dom.chainLabel.title = label.title;
}

// ------------------------------------------------------------------- avatars

/** The collection deployed to the chain the player's wallet is actually on. */
function avatarCollection(): AvatarCollectionInfo | null {
  const chainId = app.wallet?.chainId ?? 0;
  return app.avatarCollections.find((entry) => entry.chainId === chainId) ?? null;
}

/**
 * Shows what the player owns on their own chain.
 *
 * Reads rather than assumes: the same wallet can hold an avatar on one chain
 * and none on another, and the arena will show whichever one belongs to the
 * chain they staked from.
 */
export async function renderAvatarPanel(): Promise<void> {
  const wallet = app.wallet;
  const collection = avatarCollection();

  dom.avatarChain.textContent = collection ? chainInfo(collection.chainId).name : 'no collection';

  let status: AvatarStatus | null = null;
  if (wallet && collection) {
    try {
      status = await wallet.avatarStatus(collection.address);
    } catch (error) {
      // Almost always a wallet pointed at a chain the collection is not on.
      dom.mintAvatar.disabled = true;
      dom.avatarStatus.textContent = `Could not read the collection: ${errorFirstLine(error)}`;
      return;
    }
  }

  const panel = avatarPanel(
    Boolean(wallet),
    collection,
    wallet?.chainId ?? 0,
    app.avatarCollections.length,
    status,
  );
  dom.mintAvatar.disabled = panel.mintDisabled;
  dom.avatarStatus.textContent = panel.status;
}

async function mintAvatar(): Promise<void> {
  const wallet = app.wallet;
  const collection = avatarCollection();
  if (!wallet || !collection) return;

  try {
    dom.mintAvatar.disabled = true;
    dom.avatarStatus.textContent = 'Confirm in your wallet…';
    const hash = await wallet.mintAvatar(collection.address);
    await wallet.waitFor(hash);
    toast('Avatar minted. You will wear it in your next match.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    await renderAvatarPanel();
  }
}

// ------------------------------------------------------------------ sessions

/** How long a granted key lasts. Long enough to cover a sitting, not a month. */
const SESSION_HOURS = 12;

export function renderSessionPanel(): void {
  const wallet = app.wallet;
  const active = app.session;

  dom.sessionState.textContent = active ? 'on' : 'off';
  dom.sessionState.classList.toggle('chain-chip', Boolean(active));
  dom.revokeSession.classList.toggle('hidden', !active);

  if (!wallet) {
    dom.enableSession.disabled = true;
    dom.sessionStatus.textContent = 'Connect a wallet to set up.';
    return;
  }

  if (!app.sessionDelegate) {
    dom.enableSession.disabled = true;
    dom.sessionStatus.textContent =
      'This server has no session delegate configured, so logins use your wallet.';
    return;
  }

  // The server checks a session login against the hub, so the delegation has
  // to live there: one granted on a spoke would never be honoured.
  if (wallet.chainId !== app.chainId && !active) {
    dom.enableSession.disabled = true;
    dom.sessionStatus.textContent = `Session keys are set up on ${chainInfo(app.chainId).name}. Logins here use your wallet.`;
    return;
  }

  if (active) {
    dom.enableSession.disabled = true;
    const hours = Math.floor(active.secondsLeft() / 3600);
    const minutes = Math.floor((active.secondsLeft() % 3600) / 60);
    dom.sessionStatus.textContent =
      `Signing in without prompts · expires in ${hours}h ${minutes}m · logins only, it cannot spend`;
    return;
  }

  dom.enableSession.disabled = false;
  dom.sessionStatus.textContent =
    `One signature now, then ${SESSION_HOURS}h of prompt-free reconnects. ` +
    'Stakes still go through your wallet.';
}

/** Picks up a key this browser already holds for the connected account. */
function restoreSession(): void {
  const wallet = app.wallet;
  if (!wallet || !app.sessionDelegate) {
    app.session = null;
    return;
  }
  app.session = Session.load(wallet.address, wallet.chainId, app.sessionDelegate);
}

async function enableSession(): Promise<void> {
  const wallet = app.wallet;
  const delegate = app.sessionDelegate;
  if (!wallet || !delegate) return;

  const validUntil = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const session = Session.create(wallet.address, wallet.chainId, delegate, validUntil);

  try {
    dom.enableSession.disabled = true;
    dom.sessionStatus.textContent = 'Confirm the delegation in your wallet…';

    const hash = await wallet.grantSession(delegate, session.address, validUntil);
    await wallet.waitFor(hash);

    // Stored only now: a key saved before the grant confirmed would fail every
    // login while a perfectly good wallet sat unused next to it.
    session.save();
    app.session = session;
    toast('Prompt-free logins are on. Reconnects will not prompt your wallet.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    renderSessionPanel();
  }
}

async function revokeSession(): Promise<void> {
  const wallet = app.wallet;
  const session = app.session;
  if (!wallet || !session) return;

  try {
    dom.revokeSession.disabled = true;
    const hash = await wallet.revokeSession(session.address);
    await wallet.waitFor(hash);
    toast('Session key revoked.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    // Forgotten locally either way: a key the player asked to be rid of should
    // not keep being offered just because the transaction failed.
    Session.forget(wallet.address, wallet.chainId);
    app.session = null;
    dom.revokeSession.disabled = false;
    renderSessionPanel();
  }
}
