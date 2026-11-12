import { element } from './dom.js';
import { short } from './format.js';
import { explorerTxUrl } from './views.js';

/** "tx 0x34bc…8f8b", linked to the chain's explorer where it has a public one. */
export function txLink(hash: `0x${string}`, chainId: number): HTMLElement {
  const url = explorerTxUrl(chainId, hash);
  if (!url) return element('span', '', `tx ${short(hash)}`);
  const link = element('a', 'tx-link', `tx ${short(hash)}`);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Open in the block explorer';
  return link;
}
