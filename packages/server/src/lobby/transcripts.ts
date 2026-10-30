import type { MatchArchive } from './store.js';

const ROUTE = /^\/transcripts\/(0x[0-9a-fA-F]{64})$/;

/**
 * `GET /transcripts/<hash>`: a staked match's transcript, by the hash `settle`
 * carried and the escrow stored. Public, like the match was while it ran: a
 * player's browser, the guardian or anyone else fetches it to check a result,
 * and checks it against that hash, so nothing here needs trusting.
 *
 * A practice match is its player's own, and never settles; it is not served.
 * Returns null for any other path.
 */
export async function transcriptResponse(
  archive: MatchArchive,
  path: string,
): Promise<{ status: number; body: string } | null> {
  const route = (path.split('?')[0] ?? '').replace(/\/$/, '');
  if (!route.startsWith('/transcripts/')) return null;
  const hash = ROUTE.exec(route)?.[1];
  if (!hash) return { status: 400, body: JSON.stringify({ error: 'expected /transcripts/<32-byte hex hash>' }) };
  const match = await archive.loadByTranscript(hash as `0x${string}`);
  if (!match || !match.staked) return { status: 404, body: JSON.stringify({ error: 'no staked match has that transcript' }) };
  return { status: 200, body: JSON.stringify(match.transcript) };
}
