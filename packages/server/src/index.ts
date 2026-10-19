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
  type ArchivedAnalysis,
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
export {
  Analyst,
  AnalystError,
  classify,
  type AnalysisUsage,
  type AnalystOptions,
  type AnalyzeRequest,
  type AnalyzeResult,
  type AskRequest,
  type AskResult,
  type Effort,
  type MatchAnalyst,
} from './analyst/analyst.js';
export {
  ProviderError,
  type AnalystModel,
  type ContentBlock,
  type Message,
  type ModelReply,
  type ModelRequest,
  type ToolDefinition,
  type Usage,
} from './analyst/model.js';
export { geminiModel, toGeminiRequest, type GeminiModelOptions } from './analyst/gemini.js';
export { demoModel } from './analyst/demo.js';
export { AnalystLimits, type AnalystLimitOptions, type Refusal } from './analyst/limits.js';
export { AnalystMetrics, type AnalysisOutcome, type FreshAnalysis } from './analyst/metrics.js';
export { turnCost } from './analyst/pricing.js';
export { AnalysisOutput, MalformedAnalysisError, outputSchema, parseAnalysisOutput } from './analyst/schema.js';
export { verifyMoments, refute, checkDecisiveRound, type DroppedMoment, type Verification } from './analyst/verify.js';
export { JsonFieldStream } from './analyst/stream.js';
export {
  FOLLOW_UP_INSTRUCTION,
  SYSTEM_PROMPT,
  renderAnalysis,
  renderConversation,
  sanitizeQuestion,
  wrapQuestion,
  type Exchange,
  renderOverview,
  renderRequest,
  renderRound,
  type SeatedMatch,
} from './analyst/prompt.js';
export { MatchTools, TOOLS, type ToolName, type ToolOutput } from './analyst/tools.js';
export { playReferenceMatch, type ReferenceMatch } from './analyst/reference.js';
export {
  decisiveRounds,
  markdownRow,
  referenceSuite,
  scoreAnalysis,
  summarize,
  winnerOf,
  type EvalCase,
  type EvalScore,
  type EvalSummary,
} from './analyst/evals.js';
