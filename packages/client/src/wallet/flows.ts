import { chainInfo } from '@lms/contracts';
import { type AvatarCollectionInfo, type ServerMessage } from '@lms/api';
import { app, dom, net, store } from '../context.js';
import { showScreen, toast } from '../ui/chrome.js';
import { avatarPanel, hubLabel, type AvatarStatus } from '../ui/views.js';
import { useMoveStoreFor } from '../game/salts.js';
import { generatePrivateKey } from 'viem/accounts';
import { KeyStore } from '../io/keystore.js';
import { readRaw, writeRaw } from '../io/storage.js';
import { GrantedKey } from './grant.js';
import { refreshOneClick } from './oneClick.js';
import { Wallet } from './wallet.js';
import { explainError } from '../ui/errors.js';

/**
 * Everything the player does with their wallet: connecting, logging in with
 * the session key it grants, and the avatar and hub-chain panels that depend
 * on which chain the wallet is on.
 */

export function wireWalletControls(): void {
  // Before a login it connects; after, it is the way to the account screen.
  dom.connect.onclick = () => (app.wallet ? showScreen('account') : void connectWallet());
  dom.accountBack.onclick = () => showScreen('lobby');
  dom.guestPlay.onclick = () => void playAsGuest();
  dom.accountConnect.onclick = () => void connectWallet().then(() => showScreen('lobby'));
  dom.mintAvatar.onclick = () => void mintAvatar();
  dom.forgetSession.onclick = () => void forgetGrant();

  store.subscribe(['chainId', 'wallet', 'walletChainId', 'escrow', 'spokes'], renderHubLabel);
  store.subscribe(['wallet', 'grantKey'], renderSessionPanel);
  store.subscribe(['wallet', 'walletChainId', 'avatarCollections'], () => void renderAvatarPanel());
  store.subscribe(['wallet', 'walletChainId'], renderAccountAddress);
}

/** Whether the dev burner, rather than an injected wallet, is this tab's wallet. */
function usesBurner(devKey: string | undefined): devKey is string {
  return Boolean(devKey) && !(Wallet.available() && !playerParam());
}

export async function connectWallet(): Promise<void> {
  try {
    const devKey = import.meta.env.DEV ? devBurnerKey() : undefined;
    const wallet = usesBurner(devKey)
      ? await Wallet.burner(devKey as `0x${string}`, burnerRpc())
      : await Wallet.connect((chainId) => store.set({ walletChainId: chainId }));
    // A real wallet from here on: no guest after the next reload.
    writeRaw(GUEST_FLAG, '0');
    await useWallet(wallet);
  } catch (error) {
    console.error('[wallet]', error);
    toast(explainError(error), 'error');
  }
}

/** Makes `wallet` this page's wallet, and logs in with it. */
async function useWallet(wallet: Wallet): Promise<void> {
  wallet.hubChainId = app.chainId;
  // Each wallet keeps its own sealed moves, so two players in two tabs of
  // one browser never overwrite each other's salts.
  useMoveStoreFor(wallet.address);
  if (import.meta.env.DEV && playerParam()) document.title = `P${playerParam()} · ${wallet.address.slice(0, 6)} · Last Man Standing`;
  store.set({ wallet, walletChainId: wallet.chainId, grantKey: null });
  await authenticate();
}

let resumeTried = false;

/**
 * After a reload: logs straight back in, with no prompt at all, when the
 * wallet already shares an account with this page and this browser still
 * holds a live grant for it. It matters most mid-match, with the clock
 * running. Anything less stays logged out until the player connects.
 */
export async function resumeSession(): Promise<void> {
  if (resumeTried || app.wallet || !app.chainId) return;
  resumeTried = true;
  try {
    const devKey = import.meta.env.DEV ? devBurnerKey() : undefined;
    let wallet: Wallet;
    if (usesBurner(devKey)) {
      wallet = await Wallet.burner(devKey as `0x${string}`, burnerRpc());
      if (!(await GrantedKey.load(wallet.address, app.chainId))) return;
    } else {
      const address = await Wallet.sharedAddress().catch(() => null);
      if (!address || !(await GrantedKey.load(address, app.chainId))) {
        // Last time this browser played as a guest: it still is one.
        if (readRaw(GUEST_FLAG) === '1') await playAsGuest(false);
        return;
      }
      wallet = await Wallet.connect((chainId) => store.set({ walletChainId: chainId }));
    }
    await useWallet(wallet);
  } catch (error) {
    // The player can still connect by hand.
    console.warn('[wallet] could not log back in', error);
  }
}

/**
 * Signs in for a practice match: with the wallet this browser has, whose
 * only prompt is a login signature, or as a guest when it has none.
 */
export async function signInToPractise(): Promise<void> {
  const devKey = import.meta.env.DEV ? devBurnerKey() : undefined;
  if (Wallet.available() || devKey) {
    toast('Practice is free: your wallet only signs a login, never a transaction.', 'info');
    await connectWallet();
  } else {
    await playAsGuest();
  }
}

/** Whether this browser played as a guest last, so a reload picks the guest back up. */
const GUEST_FLAG = 'lms:guest';
/** The guest's key, sealed like a session key. The same guest every visit, so its history stays. */
const GUEST_KEY = 'guest-key';

/**
 * Plays as a guest: a key made in and kept by this browser, which needs no
 * wallet and no prompt. It can practise, keep a history and do everything
 * that is free; staking needs a real wallet, which can be connected any time.
 */
export async function playAsGuest(announce = true): Promise<void> {
  try {
    const keys = KeyStore.open();
    let key = await keys.read(GUEST_KEY);
    if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) {
      key = generatePrivateKey();
      await keys.write(GUEST_KEY, key);
    }
    writeRaw(GUEST_FLAG, '1');
    await useWallet(Wallet.guest(key as `0x${string}`));
    if (announce) toast('Playing as a guest. Connect a wallet any time to play for stakes.', 'info');
  } catch (error) {
    console.error('[guest]', error);
    toast(`Could not start as a guest: ${explainError(error)}`, 'error');
  }
}

function renderAccountAddress(): void {
  const wallet = app.wallet;
  dom.accountGuest.classList.toggle('hidden', !wallet?.isGuest);
  // The whole line, not just its button: "No wallet? :" alone reads as a glitch.
  (dom.guestPlay.parentElement ?? dom.guestPlay).classList.toggle('hidden', Boolean(wallet));
  if (wallet?.isGuest) {
    dom.accountAddress.textContent = `Guest ${wallet.address.slice(0, 6)}… · practice only`;
    return;
  }
  // A wallet with no node behind it (the dev burner offline) is on no chain worth naming.
  const where = wallet && wallet.chainId !== 0 ? ` · on ${chainInfo(wallet.chainId).name}` : '';
  dom.accountAddress.textContent = wallet ? `${wallet.address}${where}` : 'No wallet connected.';
}

/** True from sending a login under a stored grant until the server answers it. */
let storedGrantPending = false;

/** `?player=N`, 1-based, or null. Picks the N-th of `VITE_DEV_KEYS` for this tab. */
function playerParam(): number | null {
  const raw = new URLSearchParams(location.search).get('player');
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The dev burner's key. `VITE_DEV_KEYS` (comma-separated) gives each tab its
 * own player with `?player=N`, so one browser can seat a whole table; without
 * it, `VITE_DEV_KEY`. A `?player=` beyond the list falls back to the wallet
 * extension, if any.
 */
function devBurnerKey(): string | undefined {
  const keys = (import.meta.env.VITE_DEV_KEYS ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  const n = playerParam();
  if (n !== null) return keys[n - 1];
  return import.meta.env.VITE_DEV_KEY || keys[0];
}

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
    store.set({ grantKey: key });
    storedGrantPending = stored !== null;
    const signature = await key.signLogin(app.nonce);
    net.send({ type: 'auth', address: wallet.address, signature, grant: key.signed });
  } catch (error) {
    console.error('[auth]', error);
    toast(`Login signature failed: ${explainError(error)}`, 'error');
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
  store.set({ grantKey: null });
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

/**
 * Asks the wallet to move to the hub, for the panels that only work there:
 * staking and governance. Every panel listening to `walletChainId` redraws.
 */
export async function switchToHub(): Promise<void> {
  const wallet = app.wallet;
  if (!wallet) return toast('Connect a wallet first.', 'error');
  try {
    await wallet.onHub();
  } catch (error) {
    toast(explainError(error), 'error');
  }
  // Also after a refusal: the wallet may have moved anyway, or not at all.
  store.set({ walletChainId: wallet.chainId });
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
      dom.avatarStatus.textContent = `Could not read the collection: ${explainError(error)}`;
      return;
    }
  }

  const panel = avatarPanel(
    Boolean(wallet && !wallet.isGuest),
    collection,
    wallet?.chainId ?? 0,
    app.avatarCollections.length,
    status,
  );
  dom.mintAvatar.disabled = panel.mintDisabled;
  dom.avatarStatus.textContent = panel.status;
  // Wearing one: ask the server for its picture, which it resolves from the
  // token's metadata. The page fetches none itself.
  if (wallet && status && status.equipped > 0n) net.send({ type: 'avatar', chainId: wallet.chainId });
  else showAvatarImage(null);
}

/** The server's answer to `avatar`: the picture of the avatar this wallet wears. */
export function onAvatar(message: Extract<ServerMessage, { type: 'avatar' }>): void {
  if (message.chainId !== app.wallet?.chainId) return;
  showAvatarImage(message.avatar?.image ?? null);
}

function showAvatarImage(url: string | null): void {
  const image = dom.avatarImage;
  if (!url) {
    image.classList.add('hidden');
    image.removeAttribute('src');
    return;
  }
  // A gateway that does not answer, or one the page's policy does not
  // allow, leaves the status line alone rather than a broken picture.
  image.onerror = () => image.classList.add('hidden');
  image.onload = () => image.classList.remove('hidden');
  image.src = url;
}

async function mintAvatar(): Promise<void> {
  const wallet = app.wallet;
  const collection = avatarCollection();
  if (!wallet || !collection) return;

  try {
    dom.mintAvatar.disabled = true;
    dom.avatarStatus.textContent = 'Confirm in your wallet…';
    const hash = await wallet.mintAvatar(collection.address);
    await wallet.waitFor(hash, 'Mint avatar');
    toast('Avatar minted. You will wear it in your next match.', 'success');
  } catch (error) {
    toast(explainError(error), 'error');
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
async function forgetGrant(): Promise<void> {
  const wallet = app.wallet;
  if (wallet) await GrantedKey.forget(wallet.address, app.chainId);
  store.set({ grantKey: null });
  toast('Session key forgotten. Your wallet is asked for a new one now.');
  // The socket was logged in under the old key, and nothing could sign a
  // move from here: log it out, and back in under a new grant, which asks
  // the wallet once. A seat in a running match is re-attached on login.
  net.close();
  net.connect();
}
