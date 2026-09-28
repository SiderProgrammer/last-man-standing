import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import {
  AUTH_PREFIX,
  errorMessage,
  isActionValue,
  type AvatarCollectionInfo,
  type ClientMessage,
  type LobbyInfo,
  type ServerMessage,
  type ZapInfo,
} from '@lms/protocol';
import type { Lobby } from '../lobby/lobby.js';
import type { SessionRelayer } from '../chain/relayer.js';
import { errorFrame, parseClientMessage } from './frames.js';
import type { Client } from '../match/room.js';

/**
 * Checks a login signature against an address.
 *
 * Injected rather than fixed, because the two cases need different machinery.
 * A plain EOA is verified with `ecrecover` and no network at all, which is what
 * practice-only mode runs on. An account that has delegated under EIP-7702
 * signs its logins with a *session key*, so the signature does not recover to
 * the account address and only the account itself can say whether it is valid —
 * an ERC-1271 `isValidSignature` call, which needs an RPC.
 */
export type SignatureVerifier = (args: {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
}) => Promise<boolean>;

/**
 * The slice of `ws` the gateway actually uses, so tests can supply a fake.
 *
 * Two named methods rather than an overloaded `on`: an overload set is not
 * structurally satisfiable by a simple fake, so every implementation — the
 * real `ws` in `main.ts` and the `FakeSocket` in the tests — had to be cast
 * into place. `ws` satisfies this shape directly.
 */
export interface Socket {
  readyState: number;
  send(data: string): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
}

const OPEN = 1;

interface Session extends Client {
  readonly nonce: string;
  socket: Socket;
}

export interface GatewayOptions {
  lobby: Lobby;
  chainId: number;
  /** Hub escrow, so the client knows where to stake. Null in practice-only mode. */
  escrow?: `0x${string}` | null;
  /** Avatar collections, so the client knows where to mint on its own chain. */
  avatarCollections?: AvatarCollectionInfo[];
  /** 7702 delegate the client may grant a session key against. */
  sessionDelegate?: `0x${string}` | null;
  /** Token payment through `ZapJoin`. Null or omitted offers ETH only. */
  zap?: ZapInfo | null;
  /** Submits session-authorised calls on players' behalf. */
  relayer?: SessionRelayer;
  /** Lobby directory from the chain bridge. Empty when running without an RPC. */
  directory: () => { open: LobbyInfo[]; live: LobbyInfo[] };
  /**
   * How login signatures are checked. Defaults to offline `ecrecover`, which
   * accepts EOAs only; supply an RPC-backed verifier to also accept session
   * keys from 7702-delegated accounts.
   */
  verify?: SignatureVerifier;
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
    session.send({
      type: 'hello',
      nonce: session.nonce,
      chainId: this.options.chainId,
      escrow: this.options.escrow ?? null,
      avatarCollections: this.options.avatarCollections ?? [],
      sessionDelegate: this.options.sessionDelegate ?? null,
      zap: this.options.zap ?? null,
    });

    socket.onMessage((data: unknown) => {
      void this.dispatch(session, String(data)).catch((error: unknown) => {
        session.send(errorFrame(error));
      });
    });

    socket.onClose(() => {
      for (const room of this.options.lobby.list()) room.detach(session);
      this.sessions.delete(socket);
    });
  }

  private async dispatch(session: Session, raw: string): Promise<void> {
    const message = parseClientMessage(raw);

    if (message.type === 'auth') {
      const verify = this.options.verify ?? offlineVerify;
      const valid = await verify({
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
      case 'lobbies': {
        const directory = this.options.directory?.() ?? { open: [], live: [] };
        session.send({ type: 'lobbies', open: directory.open, live: directory.live });
        return;
      }
      case 'practice': {
        const room = this.options.lobby.createPractice(address, message.bots ?? 3, now);
        room.attach(session);
        return;
      }
      case 'watch': {
        this.options.lobby.attach(message.matchId, session);
        return;
      }
      case 'relay': {
        const relayer = this.options.relayer;
        if (!relayer?.enabled) throw new Error('session relaying is not enabled on this server');

        // Submitted for the authenticated address and no other: the signature
        // proves the session key spoke, but only this socket's login proves
        // which account is asking, and the two must be the same account.
        const hash = await relayer.submit({
          account: address,
          target: message.target,
          value: BigInt(message.value),
          data: message.data,
          nonce: BigInt(message.nonce),
          signature: message.signature,
        });
        session.send({ type: 'relayed', hash });
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

/** `ecrecover` only: no network, and therefore no ERC-1271. */
const offlineVerify: SignatureVerifier = (args) => verifyMessage(args);

