import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@lms/api';
import { Net } from '../src/io/net.js';

/** Just enough of a browser `WebSocket` for `Net`: every instance is recorded. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('Net', () => {
  beforeEach(() => {
    FakeSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const net = () =>
    new Net(
      'ws://test',
      () => {},
      () => {},
    );

  it('opens one socket however often connect is called', () => {
    const socket = net();
    socket.connect();
    socket.connect();

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('stops delivering to a handler once it is removed', () => {
    const socket = net();
    const seen: ServerMessage[] = [];
    const handler = (message: ServerMessage) => seen.push(message);
    socket.on(handler);
    socket.connect();

    FakeSocket.instances[0]?.receive({ type: 'error', code: 'X', message: 'one' });
    socket.off(handler);
    FakeSocket.instances[0]?.receive({ type: 'error', code: 'X', message: 'two' });

    expect(seen).toHaveLength(1);
  });

  it('reconnects after a drop, and close cancels a pending reconnect', () => {
    const socket = net();
    socket.connect();
    FakeSocket.instances[0]?.close();
    vi.runOnlyPendingTimers();
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]?.close();
    socket.close();
    vi.runOnlyPendingTimers();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('does not let a closed socket clear the one that replaced it', () => {
    const socket = net();
    socket.connect();
    const first = FakeSocket.instances[0];
    socket.close();
    socket.connect();
    first?.onclose?.();
    socket.connect();

    expect(FakeSocket.instances).toHaveLength(2);
  });
});
