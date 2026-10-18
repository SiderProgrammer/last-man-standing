/**
 * The package's public surface.
 *
 * Exports only. Booting lives in `main.ts`, so importing `@lms/server` — as
 * every server test does — never opens a port, starts a ticker or reads the
 * environment beyond `config`.
 */
export { Room, type Client, type MatchFinished, type RoomOptions } from './match/room.js';
export { Lobby, type LobbyOptions } from './lobby/lobby.js';
export { MemoryStyleBook, PostgresStyleBook, createStyleBook, type StyleBook } from './lobby/styles.js';
export { Gateway, type GatewayOptions, type Peer, type Socket, type SignatureVerifier } from './gateway/gateway.js';
export {
  CloseCode,
  DEFAULT_GATEWAY_LIMITS,
  KeyedLimiter,
  TokenBucket,
  type GatewayLimits,
} from './gateway/limits.js';
export { Heartbeat, type Pingable } from './gateway/heartbeat.js';
export { peerFrom, type UpgradeRequest } from './gateway/peer.js';
export { VerifyPool, layeredVerifier } from './gateway/verifyPool.js';
export {
  MemoryArchive,
  PostgresArchive,
  createArchive,
  type ArchivedMatch,
  type MatchArchive,
} from './lobby/store.js';
export {
  signResult,
  packSignatures,
  createRelayer,
  relayerFrom,
  nullRelayer,
  type Relayer,
} from './chain/attestor.js';
export { BotDriver } from './bots/bots.js';
export { FrameError, errorFrame, parseClientMessage } from './gateway/frames.js';
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
export { parseZapTokens, zapInfo } from './chain/zap.js';
export {
  DEFAULT_FEE_KEEPER_POLICY,
  FeeKeeper,
  feeKeeperPolicy,
  viemFeeRouter,
  type FeeKeeperPolicy,
  type FeeRouterPort,
  type ViemFeeRouterOptions,
} from './chain/feeKeeper.js';
export {
  ProposalIndex,
  proposalsResponse,
  viemProposalReader,
  type ProposalReader,
} from './chain/proposals.js';
export { config, loadConfig, type ServerConfig } from './config.js';
