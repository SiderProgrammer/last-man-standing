import type { Peer } from './gateway.js';

/** The parts of an HTTP upgrade request `peerFrom` reads. */
export interface UpgradeRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}

/**
 * Identifies the client behind a WebSocket upgrade.
 *
 * `trustedHops` is how many proxies of this deployment's own sit in front of
 * the server. Each appends the address it took the connection from to
 * `X-Forwarded-For`, so the client is the entry that many places from the
 * right of the chain, the socket's own address counted as the last: the
 * right-most entry no trusted proxy wrote. Everything left of it a client
 * could have sent itself, which is why the left-most entry is never taken.
 * Zero, the default, ignores the header entirely.
 */
export function peerFrom(request: UpgradeRequest, trustedHops = 0): Peer {
  const peer: Peer = {};
  const remote = request.socket.remoteAddress;
  const forwarded = trustedHops > 0 ? all(request.headers['x-forwarded-for']) : [];
  const chain = remote ? [...forwarded, remote] : forwarded;
  const ip = chain[Math.max(0, chain.length - 1 - trustedHops)];
  if (ip) peer.ip = ip;
  const origin = first(request.headers.origin);
  if (origin) peer.origin = origin;
  return peer;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Every address in every `X-Forwarded-For` header, in order. */
function all(value: string | string[] | undefined): string[] {
  const headers = Array.isArray(value) ? value : value ? [value] : [];
  return headers.flatMap((header) => header.split(',')).map((entry) => entry.trim()).filter(Boolean);
}
