import {
  MAX_QUESTION_CHARS,
  errorMessage,
  isActionValue,
  type ActionValue,
  type ClientMessage,
  type MoveAim,
  type ServerMessage,
} from '@lms/protocol';

/**
 * Socket frame decoding, and the error frame that goes back when it fails.
 *
 * Every field of every message is checked here, at the boundary, so nothing
 * past `parseClientMessage` ever sees a value of the wrong shape: a `BigInt`
 * of a non-numeric string, a seat index of `1e9`, a hex string that is not
 * hex. A frame that fails throws a `FrameError`, which the gateway counts
 * against the socket.
 */

/** A frame that is not a well-formed `ClientMessage`. */
export class FrameError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** Any even-length hex. Session-key and ERC-1271 signatures are not always 65 bytes. */
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
/** A uint256 in decimal: at most 78 digits, no sign, no exponent. */
const UINT_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
/** Generous for any signature scheme, still far below the frame cap. */
const MAX_SIGNATURE_HEX = 2 + 2 * 1024;

export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FrameError('payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    throw new FrameError('payload has no message type');
  }
  const frame = parsed as Record<string, unknown>;

  switch (frame.type) {
    case 'auth':
      return { type: 'auth', address: address(frame, 'address'), signature: signature(frame, 'signature') };
    case 'lobbies':
      return { type: 'lobbies' };
    case 'collect':
      return { type: 'collect' };
    case 'practice': {
      if (frame.bots === undefined) return { type: 'practice' };
      // The lobby clamps to the rules' seat range; this only rules out garbage.
      return { type: 'practice', bots: integer(frame, 'bots', 0, 16) };
    }
    case 'watch':
      return { type: 'watch', matchId: bytes32(frame, 'matchId') };
    case 'analyze':
      return { type: 'analyze', matchId: bytes32(frame, 'matchId') };
    case 'analysis.ask': {
      const question = string(frame, 'question');
      if (question.trim().length === 0) throw new FrameError('question must not be empty');
      if (question.length > MAX_QUESTION_CHARS) {
        throw new FrameError(`question must be at most ${MAX_QUESTION_CHARS} characters`);
      }
      return { type: 'analysis.ask', matchId: bytes32(frame, 'matchId'), question };
    }
    case 'commit': {
      const commitment = bytes32(frame, 'commitment');
      if (frame.hold === undefined) return { type: 'commit', commitment, ...aim(frame) };
      if (typeof frame.hold !== 'object' || frame.hold === null) throw new FrameError('hold must be an object');
      const hold = frame.hold as Record<string, unknown>;
      return {
        type: 'commit',
        commitment,
        hold: { action: action(hold), target: integer(hold, 'target', 0, 255), salt: bytes32(hold, 'salt') },
        ...aim(frame),
      };
    }
    case 'reveal':
      return {
        type: 'reveal',
        action: action(frame),
        target: integer(frame, 'target', 0, 255),
        salt: bytes32(frame, 'salt'),
        ...aim(frame),
      };
    case 'relay':
      return {
        type: 'relay',
        target: address(frame, 'target'),
        value: decimal(frame, 'value'),
        data: hex(frame, 'data'),
        nonce: decimal(frame, 'nonce'),
        signature: signature(frame, 'signature'),
      };
    default:
      throw new FrameError('unsupported message');
  }
}

/** The optional match and round a move names; absent fields stay absent. */
function aim(frame: Record<string, unknown>): MoveAim {
  const out: MoveAim = {};
  if (frame.matchId !== undefined) out.matchId = bytes32(frame, 'matchId');
  if (frame.round !== undefined) out.round = integer(frame, 'round', 0, 0xffffffff);
  return out;
}

function string(frame: Record<string, unknown>, field: string): string {
  const value = frame[field];
  if (typeof value !== 'string') throw new FrameError(`${field} must be a string`);
  return value;
}

function matching(frame: Record<string, unknown>, field: string, pattern: RegExp, what: string): `0x${string}` {
  const value = string(frame, field);
  if (!pattern.test(value)) throw new FrameError(`${field} must be ${what}`);
  return value as `0x${string}`;
}

function address(frame: Record<string, unknown>, field: string): `0x${string}` {
  return matching(frame, field, ADDRESS, 'an address');
}

function bytes32(frame: Record<string, unknown>, field: string): `0x${string}` {
  return matching(frame, field, BYTES32, '32 bytes of hex');
}

function hex(frame: Record<string, unknown>, field: string): `0x${string}` {
  return matching(frame, field, HEX, 'hex');
}

function signature(frame: Record<string, unknown>, field: string): `0x${string}` {
  const value = hex(frame, field);
  if (value.length < 4 || value.length > MAX_SIGNATURE_HEX) throw new FrameError(`${field} has an implausible length`);
  return value;
}

function decimal(frame: Record<string, unknown>, field: string): string {
  const value = string(frame, field);
  if (!UINT_DECIMAL.test(value)) throw new FrameError(`${field} must be a non-negative decimal integer`);
  return value;
}

function integer(frame: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = frame[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new FrameError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function action(frame: Record<string, unknown>): ActionValue {
  const value = frame.action;
  if (!isActionValue(value)) throw new FrameError('unknown action');
  return value;
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
