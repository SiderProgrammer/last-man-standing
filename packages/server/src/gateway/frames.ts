import { errorMessage, type ClientMessage, type ServerMessage } from '@lms/protocol';

/**
 * Socket frame decoding, and the error frame that goes back when it fails.
 *
 * Kept apart from the gateway so the one unchecked cast in the server has a
 * single home and an explanation attached to it.
 */

/**
 * Decodes a client frame.
 *
 * Only the envelope is checked: that the payload is JSON, is an object, and
 * carries a `type`. The fields inside are **not** validated — `target`,
 * `value` and `nonce` all reach the room and the relayer as whatever
 * the client sent, and the cast below says so out loud. See `docs/TODO.md`
 * §3.4; tightening it changes what a malformed frame does, so it is not part
 * of a behaviour-preserving refactor.
 */
export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    throw new Error('payload has no message type');
  }
  return parsed as ClientMessage;
}

/**
 * The error frame for a rejected request.
 *
 * `code` is machine-readable in the wire format but constant in practice:
 * every failure goes out as `REJECTED`, and the client never reads the field.
 * The engine's `MatchError` already carries a real code that is discarded
 * here. Funnelled through one function so that changing it later — either to
 * forward `MatchError.code` or to drop the field — is a single edit rather
 * than a hunt. Both are wire changes; see `docs/TODO.md` §3.4.
 */
export function errorFrame(error: unknown): Extract<ServerMessage, { type: 'error' }> {
  return { type: 'error', code: 'REJECTED', message: errorMessage(error) };
}
