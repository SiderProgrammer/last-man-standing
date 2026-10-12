import { readFileSync } from 'node:fs';
import { isAddress, isHex, type Hex } from 'viem';
import { addressKey, type AirdropAllocation } from '@lms/protocol';

/**
 * The published `airdrop.json`, served one address at a time.
 *
 * The file holds every claim's proof; the contract holds only the root. Serving
 * proofs from here is what lets the client offer a one-click claim instead of
 * asking players to find their row in a JSON file. Nothing here is trusted:
 * a wrong proof is rejected by the contract, and the root is checked against
 * the deployed airdrop at boot.
 */
export interface AirdropBook {
  readonly root: Hex;
  readonly size: number;
  lookup(address: string): AirdropAllocation | null;
}

/** Parses the output of `scripts/airdrop.mjs`, rejecting anything malformed. */
export function parseAirdropFile(json: string): AirdropBook {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('airdrop file is not an object');
  const { root, claims } = parsed as { root?: unknown; claims?: unknown };
  if (typeof root !== 'string' || !isHex(root) || root.length !== 66) {
    throw new Error('airdrop file has no valid root');
  }
  if (!claims || typeof claims !== 'object') throw new Error('airdrop file has no claims');

  const book = new Map<string, AirdropAllocation>();
  for (const [account, claim] of Object.entries(claims as Record<string, unknown>)) {
    if (!isAddress(account)) throw new Error(`airdrop file has a bad address: ${account}`);
    const { amount, proof } = (claim ?? {}) as { amount?: unknown; proof?: unknown };
    if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
      throw new Error(`airdrop file has a bad amount for ${account}`);
    }
    if (!Array.isArray(proof) || !proof.every((node) => typeof node === 'string' && isHex(node) && node.length === 66)) {
      throw new Error(`airdrop file has a bad proof for ${account}`);
    }
    book.set(addressKey(account), { amount, proof: proof as Hex[] });
  }

  return {
    root,
    size: book.size,
    lookup: (address) => (isAddress(address) ? (book.get(addressKey(address)) ?? null) : null),
  };
}

export function loadAirdropFile(path: string): AirdropBook {
  return parseAirdropFile(readFileSync(path, 'utf8'));
}

const ROUTE = /^\/airdrop\/(0x[0-9a-fA-F]{40})\/?$/;

/**
 * Answers `GET /airdrop/<address>`, or returns null for any other path.
 *
 * 404 for an address with no allocation, so the client can tell "nothing for
 * you" apart from a server that has no airdrop at all (also 404, with a
 * different body) only by caring about the first.
 */
export function airdropResponse(
  book: AirdropBook | null,
  path: string,
): { status: number; body: string } | null {
  const match = ROUTE.exec(path.split('?')[0] ?? '');
  if (!match) return null;
  if (!book) return { status: 404, body: JSON.stringify({ error: 'no airdrop' }) };
  const allocation = book.lookup(match[1]!);
  return allocation
    ? { status: 200, body: JSON.stringify(allocation) }
    : { status: 404, body: JSON.stringify({ error: 'no allocation' }) };
}
