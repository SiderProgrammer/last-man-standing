import { app, dom } from '../context.js';
import { Wallet, type TransactionEvent } from '../wallet/wallet.js';
import { element } from './dom.js';
import { txLink } from './links.js';

/**
 * The transaction tray: every transaction this page sent and waits on, as a
 * row that goes from sent to confirmed or failed, linked to the explorer. A
 * stake crossing chains stays as "in transit" until it lands. Confirmed rows
 * leave after a while; failed ones stay until dismissed.
 */

interface Row {
  event: TransactionEvent;
  node: HTMLElement;
}

const rows = new Map<string, Row>();
const MAX_ROWS = 5;
const CONFIRMED_MS = 20_000;

export function wireTxTray(): void {
  Wallet.onTransaction = onTransaction;
}

function onTransaction(event: TransactionEvent): void {
  const key = event.hash.toLowerCase();
  const row = rows.get(key) ?? { event, node: element('div', 'tx-row') };
  row.event = event;
  rows.set(key, row);
  draw(row);
  if (!row.node.isConnected) dom.txTray.prepend(row.node);
  while (rows.size > MAX_ROWS) {
    const [oldest] = rows.keys();
    if (oldest === undefined) break;
    rows.get(oldest)?.node.remove();
    rows.delete(oldest);
  }
  if (event.status === 'confirmed') setTimeout(() => remove(key), CONFIRMED_MS);
  dom.txTray.classList.toggle('hidden', rows.size === 0);
}

function draw(row: Row): void {
  const { event } = row;
  const status: Record<TransactionEvent['status'], string> = {
    sent: 'sent · waiting to confirm…',
    confirmed: 'confirmed',
    failed: `failed${event.reason ? `: ${event.reason}` : ''}`,
  };
  row.node.className = `tx-row ${event.status}`;
  const close = element('button', 'toast-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => remove(event.hash.toLowerCase());
  const text = element('span', 'tx-text');
  text.append(element('strong', '', event.label), ` · ${status[event.status]} · `, txLink(event.hash, event.chainId || app.chainId));
  row.node.replaceChildren(text, close);
}

function remove(key: string): void {
  rows.get(key)?.node.remove();
  rows.delete(key);
  dom.txTray.classList.toggle('hidden', rows.size === 0);
}
