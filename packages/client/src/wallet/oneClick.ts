import {
  ONE_CLICK_CAPS,
  errorFirstLine,
  joinCall,
  withdrawForCall,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type SessionCallParams,
} from '@lms/protocol';
import { formatEther, type Hex } from 'viem';
import { app, dom, net, store } from '../context.js';
import { toast } from '../ui/chrome.js';

/**
 * One-click play: joins and collecting winnings with no wallet prompt and no
 * gas, for wallets that can sign an EIP-7702 authorization themselves — the
 * dev burner and embedded wallets.
 *
 * The wallet delegates to `SessionKeyDelegate` once and grants the browser's
 * session key a capped session on-chain. After that the key signs each join,
 * the server submits it and pays the gas, and the stake comes out of the
 * wallet. Injected wallets never see this: they cannot be asked to authorize
 * a delegate of our choosing, so their joins stay their own transactions.
 */

/** A relayed call the server refused. The caller falls back to the wallet. */
export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

const pending = new Map<string, { resolve: (tx: Hex) => void; reject: (error: Error) => void }>();
let nextId = 0;

export function onRelayed(message: Extract<ServerMessage, { type: 'relayed' }>): void {
  pending.get(message.id)?.resolve(message.tx);
  pending.delete(message.id);
}

export function onRelayError(message: Extract<ServerMessage, { type: 'relay.error' }>): void {
  pending.get(message.id)?.reject(new RelayError(message.code, message.message));
  pending.delete(message.id);
}

/** True when this join or collect can go through the relayer. */
export function canRelay(): boolean {
  return app.oneClick && Boolean(app.wallet && app.grantKey && app.escrow);
}

/** Joins a lobby through the relayer. Resolves once the join is mined. */
export function relayJoin(matchId: Hex, stake: bigint): Promise<Hex> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) throw new RelayError('UNAVAILABLE', 'connect a wallet first');
  return relay(joinCall(escrow, matchId, stake));
}

/** Collects winnings through the relayer. Resolves once the withdrawal is mined. */
export function relayCollect(): Promise<Hex> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) throw new RelayError('UNAVAILABLE', 'connect a wallet first');
  return relay(withdrawForCall(escrow, wallet.address));
}

async function relay(call: Pick<SessionCallParams, 'target' | 'value' | 'data'>): Promise<Hex> {
  const { wallet, grantKey, sessionDelegate } = app;
  if (!wallet || !grantKey || !sessionDelegate) throw new RelayError('UNAVAILABLE', 'one-click play is off');

  // Read fresh each time: another tab may have relayed a call since.
  const { nonce } = await wallet.oneClickStatus(sessionDelegate, grantKey.address);
  const params: SessionCallParams = { ...call, account: wallet.address, chainId: app.chainId, nonce };
  const signature = await grantKey.signSessionCall(params);
  return sendRelayed((id) => ({
    type: 'relay',
    id,
    call: { target: call.target, value: call.value.toString(), data: call.data, nonce: nonce.toString(), signature },
  }));
}

/**
 * Sends a frame the relayer answers by its `id`, with `relayed` or
 * `relay.error`: a session call, or a signed withdrawal to a spoke. Resolves
 * with the mined transaction, or rejects with a `RelayError`.
 */
export function sendRelayed(frame: (id: string) => ClientMessage): Promise<Hex> {
  const id = `relay-${(nextId += 1)}`;
  const landed = new Promise<Hex>((resolve, reject) => pending.set(id, { resolve, reject }));
  net.send(frame(id));
  return landed;
}

/**
 * Reads whether the current key holds a live session. Runs whenever the
 * wallet, its chain or the key changes, on login, and after either switch.
 */
export async function refreshOneClick(): Promise<void> {
  const { wallet, grantKey, sessionDelegate } = app;
  let active = false;
  if (wallet && grantKey && sessionDelegate && wallet.canDelegate && wallet.chainId === app.chainId) {
    try {
      active = (await wallet.oneClickStatus(sessionDelegate, grantKey.address)).active;
    } catch (error) {
      console.error('[one-click]', error);
    }
  }
  store.set({ oneClick: active });
}

export function renderOneClickPanel(): void {
  const { wallet, grantKey, sessionDelegate } = app;
  dom.oneClickState.textContent = app.oneClick ? 'on' : 'off';
  dom.oneClickState.classList.toggle('chain-chip', app.oneClick);
  dom.disableOneClick.classList.toggle('hidden', !app.oneClick);
  dom.enableOneClick.classList.toggle('hidden', app.oneClick);
  dom.enableOneClick.disabled = true;

  const status = (text: string) => {
    dom.oneClickStatus.textContent = text;
  };
  if (!wallet) return status('Connect a wallet to set up.');
  if (!sessionDelegate) return status('This server relays no calls; every join is your own transaction.');
  if (!wallet.canDelegate) {
    return status('Your wallet signs its own joins. One-click play is for burner and embedded wallets.');
  }
  if (wallet.chainId !== app.chainId) return status('One-click play works on the hub only.');
  if (!grantKey) return status('Log in first: one-click play uses your session key.');
  if (app.oneClick) {
    return status(`Joins and collecting need no prompt · ${app.relayQuota} relayed calls a day`);
  }
  dom.enableOneClick.disabled = false;
  status(
    `One transaction from your wallet; then up to ${formatEther(ONE_CLICK_CAPS.valueCap)} ETH a join, ` +
      `${formatEther(ONE_CLICK_CAPS.spendCap)} ETH in all, until your session key expires.`,
  );
}

export async function enableOneClick(): Promise<void> {
  const { wallet, grantKey, sessionDelegate } = app;
  if (!wallet || !grantKey || !sessionDelegate) return;
  try {
    dom.enableOneClick.disabled = true;
    dom.oneClickStatus.textContent = 'Delegating your account…';
    // The on-chain session ends with the key's grant: one key, one lifetime.
    const hash = await wallet.enableOneClick(sessionDelegate, grantKey.address, grantKey.grant.expiresAt, ONE_CLICK_CAPS);
    await wallet.waitFor(hash);
    toast('One-click play is on.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    await refreshOneClick();
  }
}

/** Ends the session on-chain, so a copied key stops working at once. */
export async function disableOneClick(): Promise<void> {
  const { wallet, grantKey } = app;
  if (!wallet || !grantKey) return;
  try {
    dom.disableOneClick.disabled = true;
    await wallet.waitFor(await wallet.revokeSession(grantKey.address));
    toast('One-click play is off.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    dom.disableOneClick.disabled = false;
    await refreshOneClick();
  }
}

export function wireOneClickControls(): void {
  dom.enableOneClick.onclick = () => void enableOneClick();
  dom.disableOneClick.onclick = () => void disableOneClick();

  const inputs = ['wallet', 'walletChainId', 'chainId', 'grantKey', 'sessionDelegate'] as const;
  store.subscribe([...inputs, 'oneClick', 'relayQuota'], renderOneClickPanel);
  store.subscribe(inputs, () => void refreshOneClick());
}
