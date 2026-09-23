import { keccak256, toHex } from 'viem';
import { DEFAULT_RULES, type Seat, type ServerMessage } from '@lms/protocol';
import type { MatchSetup } from '@lms/engine';
import type { Client } from '@lms/server';

export const HUMAN = '0x00000000000000000000000000000000000000a1' as const;

export function bytes32(label: string): `0x${string}` {
  return keccak256(toHex(label));
}

export function setupWithBots(seatCount: number, label = 'room'): MatchSetup {
  const seats: Seat[] = Array.from({ length: seatCount }, (_, index) => ({
    index,
    address: index === 0 ? HUMAN : (`0x${(index + 0xb0).toString(16).padStart(40, '0')}` as const),
    chainId: 11155111,
  }));
  return {
    matchId: bytes32(`match:${label}`),
    seats,
    seed: bytes32(`seed:${label}`),
    rules: DEFAULT_RULES,
  };
}

export function botSeats(seatCount: number): number[] {
  return Array.from({ length: seatCount - 1 }, (_, i) => i + 1);
}

/**
 * Most recent message of a given type, or undefined.
 *
 * Free function rather than a method because the two fakes that need it
 * implement different interfaces — `FakeClient` is a `Client`, `FakeSocket` is
 * a `Socket` — so neither can inherit it from the other.
 */
export function lastOfType<T extends ServerMessage['type']>(
  messages: readonly ServerMessage[],
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
  return undefined;
}

/** Records everything the room pushes, so tests can assert on the feed. */
export class FakeClient implements Client {
  readonly received: ServerMessage[] = [];

  constructor(public address: `0x${string}` | null) {}

  send(message: ServerMessage): void {
    this.received.push(message);
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return lastOfType(this.received, type);
  }

  all<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.received.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    );
  }
}
