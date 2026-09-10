import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import { AUTH_PREFIX, isActionValue, type ClientMessage, type ServerMessage } from '@lms/protocol';
import type { Lobby } from './lobby.js';
import type { Client } from './room.js';

/** The slice of `ws` the gateway actually uses, so tests can supply a fake. */
export interface Socket {
  readyState: number;
  send(data: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
}

const OPEN = 1;

interface Session extends Client {
  readonly nonce: string;
  socket: Socket;
}

export interface GatewayOptions {
  lobby: Lobby;
  chainId: number;
  /** Wall clock, injectable for tests. */
  now?: () => number;
}

/**
 * Translates socket frames into room calls.
 *
 * Login is a plain signed nonce rather than a session cookie: the wallet is
 * the identity, and the signature proves control of the address that staked
 * on-chain. Nothing here trusts a client-supplied address on its own.
 */
export class Gateway {
  private readonly sessions = new Map<Socket, Session>();

  constructor(private readonly options: GatewayOptions) {}

  get connections(): number {
    return this.sessions.size;
  }

  accept(socket: Socket): void {
    const session: Session = {
      socket,
      address: null,
      nonce: randomBytes(16).toString('hex'),
      send: (message) => this.write(socket, message),
    };
    this.sessions.set(socket, session);
    session.send({ type: 'hello', nonce: session.nonce, chainId: this.options.chainId });

    socket.on('message', (data: unknown) => {
      void this.dispatch(session, String(data)).catch((error: unknown) => {
        session.send({ type: 'error', code: 'REJECTED', message: describe(error) });
      });
    });

    socket.on('close', () => {
      for (const room of this.options.lobby.list()) room.detach(session);
      this.sessions.delete(socket);
    });
  }

  private async dispatch(session: Session, raw: string): Promise<void> {
    const message = parse(raw);

    if (message.type === 'auth') {
      const valid = await verifyMessage({
        address: message.address,
        message: `${AUTH_PREFIX}${session.nonce}`,
        signature: message.signature,
      });
      if (!valid) throw new Error('login signature does not match the nonce');
      session.address = message.address;
      session.send({ type: 'authed', address: message.address });
      return;
    }

    const address = session.address;
    if (!address) throw new Error('authenticate before acting');
    const now = this.options.now?.() ?? Date.now();

    switch (message.type) {
      case 'practice': {
        const room = this.options.lobby.createPractice(address, message.bots ?? 3, now);
        room.attach(session);
        return;
      }
      case 'watch': {
        this.options.lobby.attach(message.matchId, session);
        return;
      }
      case 'commit': {
        this.requireRoom(address).submitCommit(address, message.commitment, now);
        return;
      }
      case 'reveal': {
        if (!isActionValue(message.action)) throw new Error('unknown action');
        this.requireRoom(address).submitReveal(
          address,
          { action: message.action, target: message.target, salt: message.salt },
          now,
        );
        return;
      }
      case 'bet': {
        this.requireRoom(address).placeBet(address, message.target, message.chips);
        return;
      }
      default: {
        throw new Error('unsupported message');
      }
    }
  }

  private requireRoom(address: `0x${string}`) {
    const room = this.options.lobby.roomFor(address);
    if (!room) throw new Error('you are not in a live match');
    return room;
  }

  private write(socket: Socket, message: ServerMessage): void {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
  }
}

function parse(raw: string): ClientMessage {
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
