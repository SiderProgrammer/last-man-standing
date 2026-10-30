import {
  chainInfo,
  errorFirstLine,
  type AvatarCollectionInfo,
} from '@lms/protocol';
import { app, dom, net } from '../context.js';
import { toast } from '../ui/chrome.js';
import { avatarPanel, hubLabel, type AvatarStatus } from '../ui/views.js';
import { renderPayWith } from '../screens/lobby.js';
import { GrantedKey } from './grant.js';
import { refreshOneClick } from './oneClick.js';
import { Wallet } from './wallet.js';

/**
 * Everything the player does with their wallet: connecting, logging in with
 * the session key it grants, and the avatar and hub-chain panels that depend
 * on which chain the wallet is on.
 */

export function wireWalletControls(): void {
  dom.connect.onclick = () => void connectWallet();
  dom.mintAvatar.onclick = () => void mintAvatar();
  dom.forgetSession.onclick = forgetGrant;
}

async function connectWallet(): Promise<void> {
  try {
    const devKey = import.meta.env.DEV ? import.meta.env.VITE_DEV_KEY : undefined;
    app.wallet =
      Wallet.available() || !devKey
        ? await Wallet.connect()
        : await Wallet.burner(devKey as `0x${string}`, burnerRpc());
    app.grantKey = null;
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

/** True from sending a login under a stored grant until the server answers it. */
let storedGrantPending = false;

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

  try {
    // A stored grant logs in with no prompt at all. Only a missing or
    // expiring one asks the wallet, once, and that one grant then covers
    // every reconnect and every move until it expires.
    const stored = await GrantedKey.load(wallet.address, app.chainId);
    const key = stored ?? (await GrantedKey.create(wallet.address, app.chainId, (grant) => wallet.signGrant(grant)));
    app.grantKey = key;
    storedGrantPending = stored !== null;
    const signature = await key.signLogin(app.nonce);
    net.send({ type: 'auth', address: wallet.address, signature, grant: key.signed });
  } catch (error) {
    console.error('[auth]', error);
    toast(`Login signature failed: ${errorFirstLine(error)}`);
  } finally {
    renderSessionPanel();
  }
}

export function onAuthed(): void {
  storedGrantPending = false;
  void refreshOneClick();
}

/**
 * Called when the server refuses a login. Under a stored grant that usually
 * means the grant itself: the server's chain or origins changed, or its clock
 * disagrees about expiry. Drops it and asks the wallet for a new one, once.
 * Returns true when it handled the error that way.
 */
export function onLoginRejected(): boolean {
  if (!storedGrantPending) return false;
  storedGrantPending = false;
  const wallet = app.wallet;
  app.grantKey = null;
  toast('Session key rejected — asking your wallet for a new one.');
  // Forgotten first, or the login would load the same key straight back.
  void (wallet ? GrantedKey.forget(wallet.address, app.chainId) : Promise.resolve()).then(authenticate);
  return true;
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

export function renderSessionPanel(): void {
  const key = app.grantKey;
  dom.sessionState.textContent = key ? 'on' : 'off';
  dom.sessionState.classList.toggle('chain-chip', Boolean(key));
  dom.forgetSession.classList.toggle('hidden', !key);

  if (!app.wallet) {
    dom.sessionStatus.textContent = 'Connect a wallet to set up.';
    return;
  }
  if (!key) {
    dom.sessionStatus.textContent = 'Your wallet is asked for a grant when you log in.';
    return;
  }
  const left = Math.max(0, key.grant.expiresAt - Math.floor(Date.now() / 1000));
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  dom.sessionStatus.textContent = `Signing logins and moves · expires in ${hours}h ${minutes}m · spends only through one-click play`;
}

/**
 * Drops the key from this browser. The grant itself cannot be revoked, only
 * outlived: a copy of the key elsewhere stays usable until it expires.
 */
function forgetGrant(): void {
  const wallet = app.wallet;
  if (wallet) void GrantedKey.forget(wallet.address, app.chainId);
  app.grantKey = null;
  renderSessionPanel();
  void refreshOneClick();
  toast('Session key forgotten. Your next login asks your wallet for a new one.');
}
