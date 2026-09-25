/**
 * The package's public surface.
 *
 * Exports only. Booting lives in `main.ts`, so importing `@lms/server` — as
 * every server test does — never opens a port, starts a ticker or reads the
 * environment beyond `config`.
 */
export { Room, type Client, type MatchFinished, type RoomOptions } from './rooms/room.js';
export { Lobby, type LobbyOptions } from './rooms/lobby.js';
export { Gateway, type GatewayOptions, type Socket, type SignatureVerifier } from './gateway/gateway.js';
export {
  MemoryArchive,
  PostgresArchive,
  createArchive,
  type ArchivedMatch,
  type MatchArchive,
} from './store.js';
export {
  signResult,
  packSignatures,
  createRelayer,
  relayerFrom,
  nullRelayer,
  type Relayer,
} from './chain/attestor.js';
export { BotDriver } from './rooms/bots.js';
export { ChipLedger } from './rooms/chips.js';
export { errorFrame, parseClientMessage } from './gateway/frames.js';
export { ChainBridge, type ChainBridgeDeps, type ChainBridgeOptions } from './chain/bridge.js';
export {
  viemEscrowReader,
  type EscrowMatch,
  type EscrowReader,
  type MatchCreatedLog,
  type PlayerJoinedLog,
  type ViemEscrowReaderOptions,
} from './chain/escrowReader.js';
export {
  createSessionRelayer,
  nullSessionRelayer,
  type ChainRelayerOptions,
  type SessionCall,
  type SessionRelayer,
} from './chain/relayer.js';
export {
  AvatarRegistry,
  parseCollections,
  type AvatarCollection,
  type AvatarRegistryOptions,
  type AvatarSubject,
} from './chain/avatars.js';
export { config, loadConfig, type ServerConfig } from './config.js';
