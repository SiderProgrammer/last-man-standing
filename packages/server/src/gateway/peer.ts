import type { Peer } from './gateway.js';

/** The parts of an HTTP upgrade request `peerFrom` reads. */
export interface UpgradeRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}

/**
 * Identifies the client behind a WebSocket upgrade.
 *
 * With `trustProxy`, the IP is the left-most `X-Forwarded-For` entry — the one
 * the first proxy saw. Without it the header is ignored entirely, because a
 * client talking to the server directly can put anything in it.
 */
export function peerFrom(request: UpgradeRequest, trustProxy: boolean): Peer {
  const peer: Peer = {};
  const forwarded = first(request.headers['x-forwarded-for'])?.split(',')[0]?.trim();
  const ip = trustProxy && forwarded ? forwarded : request.socket.remoteAddress;
  if (ip) peer.ip = ip;
  const origin = first(request.headers.origin);
  if (origin) peer.origin = origin;
  return peer;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
