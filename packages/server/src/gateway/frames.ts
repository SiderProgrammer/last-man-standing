import * as z from 'zod/v4';
import { MatchError } from '@lms/engine';
import {
  BOT_DIFFICULTIES,
  errorMessage,
  isActionValue,
  type ActionValue,
  type ClientMessage,
  type ServerMessage,
} from '@lms/protocol';
import { RequestError } from '../errors.js';

/**
 * Socket frame decoding, and the error frame that goes back when it fails.
 *
 * Every field of every message is checked here, at the boundary, so nothing
 * past `parseClientMessage` ever sees a value of the wrong shape: a seat index
 * of `1e9`, a hex string that is not hex. Unknown fields are dropped, so the
 * message is rebuilt from checked fields only. A frame that fails throws a
 * `FrameError`, which the gateway counts against the socket.
 */

/** A frame that is not a well-formed `ClientMessage`. */
export class FrameError extends RequestError {
  constructor(message: string) {
    super('MALFORMED_FRAME', message);
    this.name = 'FrameError';
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** Any even-length hex. Session-key and ERC-1271 signatures are not always 65 bytes. */
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
/** Generous for any signature scheme, still far below the frame cap. */
const MAX_SIGNATURE_HEX = 2 + 2 * 1024;

const hexMatching = (pattern: RegExp, what: string) =>
  z
    .string({ error: `must be ${what}` })
    .regex(pattern, `must be ${what}`)
    .transform((value) => value as `0x${string}`);

const address = hexMatching(ADDRESS, 'an address');
const bytes32 = hexMatching(BYTES32, '32 bytes of hex');
const signature = hexMatching(HEX, 'hex').refine(
  (value) => value.length >= 4 && value.length <= MAX_SIGNATURE_HEX,
  'has an implausible length',
);

const integer = (min: number, max: number) => {
  const error = `must be an integer from ${min} to ${max}`;
  return z.number({ error }).int(error).min(min, error).max(max, error);
};

const action = z.custom<ActionValue>(isActionValue, 'unknown action');
const target = integer(0, 255);

/** The match and round a move names. */
const aim = { matchId: bytes32, round: integer(0, 0xffffffff) };

const MESSAGES: { [K in ClientMessage['type']]: z.ZodType } = {
  auth: z.object({ type: z.literal('auth'), address, signature }),
  lobbies: z.object({ type: z.literal('lobbies') }),
  practice: z.object({
    type: z.literal('practice'),
    // The lobby clamps to the rules' seat range; this only rules out garbage.
    bots: integer(0, 16).optional(),
    difficulty: z.enum(BOT_DIFFICULTIES, { error: 'unknown difficulty' }).optional(),
  }),
  watch: z.object({ type: z.literal('watch'), matchId: bytes32 }),
  analyze: z.object({ type: z.literal('analyze'), matchId: bytes32 }),
  history: z.object({ type: z.literal('history'), before: integer(0, Number.MAX_SAFE_INTEGER).optional() }),
  review: z.object({ type: z.literal('review'), matchId: bytes32 }),
  commit: z.object({
    type: z.literal('commit'),
    commitment: bytes32,
    hold: z.object({ action, target, salt: bytes32 }, { error: 'must be an object' }).optional(),
    ...aim,
  }),
  reveal: z.object({ type: z.literal('reveal'), action, target, salt: bytes32, ...aim }),
};

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
  const type = (parsed as { type: unknown }).type;
  const schema = typeof type === 'string' && Object.hasOwn(MESSAGES, type) ? MESSAGES[type as ClientMessage['type']] : null;
  if (!schema) throw new FrameError('unsupported message');

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new FrameError(issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed message');
  }
  // Each schema mirrors its `ClientMessage` variant; zod leaves an absent
  // optional field absent, which is what `exactOptionalPropertyTypes` wants.
  return result.data as ClientMessage;
}

/**
 * The error frame for a rejected request. A `RequestError` or the engine's
 * `MatchError` brings its own code; anything else is `INTERNAL`, with its
 * message kept so the cause is still visible.
 */
export function errorFrame(error: unknown): Extract<ServerMessage, { type: 'error' }> {
  const code = error instanceof RequestError || error instanceof MatchError ? error.code : 'INTERNAL';
  return { type: 'error', code, message: errorMessage(error) };
}
