import { MatchPhase } from '@lms/consensus';
import { DEFAULT_SERVER_PORT, type ServerMessage } from '@lms/api';
import { app, dom, initContext, net, store } from './context.js';
import { Net } from './io/net.js';
import { syncChainClock } from './io/chainClock.js';
import { hideLoader, showLoadProgress } from './screens/loading.js';
import { onCrossChain, onLobbies, onMatched, onWaiting, wireLobbyControls } from './screens/lobby.js';
import { onDequeued, onQueued, wireQueueControls } from './screens/queue.js';
import { refreshStaking, wireStakingPanel } from './screens/stakingPanel.js';
import { refreshGovernance, wireGovernanceNav } from './screens/governanceNav.js';
import {
  onAvatars,
  onDossier,
  onRoomClosed,
  onFinished,
  onReceipt,
  onRound,
  onDelta,
  onState,
  updateTimer,
  wireMatchControls,
} from './screens/match.js';
import { onSettled, wireResultControls } from './screens/result.js';
import { wireHelpControls } from './screens/help.js';
import { onHistory, onReview, requestHistory, wireHistoryControls } from './screens/history.js';
import {
  onAnalysisDone,
  onAnalysisError,
  onAnalysisStep,
} from './screens/analysis.js';
import { toast, wireChrome } from './ui/chrome.js';
import { wireTxTray } from './ui/txTray.js';
import { wireStatusBar } from './screens/statusBar.js';
import { queryDom } from './ui/dom.js';
import { short } from './ui/format.js';
import { httpOrigin } from './ui/staking.js';
import {
  authenticate,
  onAuthed,
  onAvatar,
  onLoginRejected,
  resumeSession,
  wireWalletControls,
} from './wallet/flows.js';
import { onBalance, renderWinnings, wirePayoutControls } from './wallet/payouts.js';
import { onRelayError, onRelayed, wireOneClickControls } from './wallet/oneClick.js';

const SERVER_URL = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:${DEFAULT_SERVER_PORT}`;

/**
 * Boots the client.
 *
 * Everything with an effect lives in here rather than at module scope, which is
 * what lets the rest of this package be imported without opening a socket.
 */
export function start(): void {
  const elements = queryDom();
  const socket = new Net(
    SERVER_URL,
    () => void authenticate(),
    (connected) => {
      if (!connected) dom.chainLabel.textContent = 'reconnecting…';
    },
  );
  initContext(elements, socket);

  // In parallel with everything below: the loading screen covers the page
  // until the arena's textures are cached, while the socket connects behind it.
  // The loader is Pixi's, which the lobby never needs, so it is fetched as a
  // chunk of its own; one that fails to arrive costs the textures, not the page.
  void import('./assets/loader.js')
    .then(({ loadAssets }) => loadAssets(showLoadProgress))
    .catch((error: unknown) => console.warn('[assets] could not load the arena', error))
    .then(hideLoader);

  net.on(onServerMessage);
  net.connect();
  wireChrome();
  wireTxTray();
  wireStatusBar();
  wireWalletControls();
  wireOneClickControls();
  wireLobbyControls();
  wireQueueControls();
  wireMatchControls();
  wirePayoutControls();
  wireResultControls(httpOrigin(SERVER_URL));
  wireHelpControls();
  wireHistoryControls();
  wireStakingPanel();
  wireGovernanceNav(httpOrigin(SERVER_URL));
  setInterval(updateTimer, 200);
  // Keeps the unstake countdown, the share price and the winnings current
  // while the page is open: a match settling or a lobby cancelled shows up
  // without a reload.
  setInterval(() => {
    refreshStaking();
    refreshGovernance();
    if (app.wallet) void renderWinnings();
  }, 30_000);
}

/** One handler per server message type: a type with none is a compile error, not a dropped message. */
type Handlers = { [K in ServerMessage['type']]: (message: Extract<ServerMessage, { type: K }>) => void };

const HANDLERS: Handlers = {
  hello: onHello,
  authed: (message) => {
    onAuthed();
    // From here the wallet button opens the account screen.
    dom.connect.textContent = app.wallet?.isGuest ? 'Guest ▾' : `${short(message.address)} ▾`;
    dom.connect.title = 'Your account: staking, avatar and session key';
    dom.connect.classList.remove('primary');
    net.flush();
    net.send({ type: 'lobbies' });
    requestHistory();
    void renderWinnings();
    refreshStaking();
    refreshGovernance();
    // A reconnect drops the socket, not the seat: ask to be re-attached to the
    // match that is still running on the server.
    if (app.match && app.match.phase !== MatchPhase.Finished) {
      net.send({ type: 'watch', matchId: app.match.matchId });
    }
  },
  lobbies: (message) => {
    if (message.chainTime !== undefined) syncChainClock(message.chainTime);
    if (app.escrowPaused !== (message.paused === true)) store.set({ escrowPaused: message.paused === true });
    onLobbies(message.open, message.live);
  },
  state: (message) => onState(message.state, message.you, Date.now() + message.msRemaining, message.waitingFor, message.holdMs),
  delta: onDelta,
  // A match this wallet sits in has its room now: go to the table.
  // Also on login, for a match still running from before a reload. Not one
  // the player chose to leave for the lobby.
  live: (message) => {
    if (app.match?.matchId !== message.matchId && app.leftMatch !== message.matchId) {
      net.send({ type: 'watch', matchId: message.matchId });
    }
  },
  closed: onRoomClosed,
  // The watch is held until the room opens; `state` follows then.
  waiting: onWaiting,
  avatars: onAvatars,
  dossier: onDossier,
  round: onRound,
  receipt: (message) => void onReceipt(message),
  finished: onFinished,
  settled: (message) => {
    void onSettled(message);
    // Archived just before this was sent, so it belongs in the list now.
    requestHistory();
  },
  history: onHistory,
  review: onReview,
  crossChain: (message) => onCrossChain(message.event),
  matched: (message) => {
    onDequeued();
    onMatched(message);
  },
  queued: onQueued,
  dequeued: () => onDequeued(),
  'analysis.step': onAnalysisStep,
  'analysis.done': onAnalysisDone,
  'analysis.error': onAnalysisError,
  relayed: onRelayed,
  balance: onBalance,
  avatar: onAvatar,
  'relay.error': onRelayError,
  error: onError,
};

/** Routes each server message to the screen that owns it. */
function onServerMessage(message: ServerMessage): void {
  (HANDLERS[message.type] as (message: ServerMessage) => void)(message);
}

function onHello(message: Extract<ServerMessage, { type: 'hello' }>): void {
  if (app.wallet) app.wallet.hubChainId = message.chainId;
  // Every panel that shows any of this is subscribed to it.
  store.set({
    nonce: message.nonce,
    chainId: message.chainId,
    escrow: message.escrow,
    avatarCollections: message.avatarCollections,
    sessionDelegate: message.sessionDelegate,
    relayQuota: message.relayQuota,
    receiptSigner: message.receiptSigner,
    practiceReceiptSigner: message.practiceReceiptSigner,
    zap: message.zap,
    spokes: message.spokes,
    staking: message.staking,
    analyst: message.analyst,
    matchmaking: message.matchmaking,
    withdrawToChain: message.withdrawToChain,
    // A new connection: the server let the old one's place in the queue go.
    queue: null,
    queuedSince: null,
  });
  // Public: a visitor sees the lobbies before connecting anything.
  net.send({ type: 'lobbies' });
  // The tab was reloaded with a live grant in this browser: log straight back in.
  void resumeSession();
}

function onError(message: Extract<ServerMessage, { type: 'error' }>): void {
  switch (message.code) {
    case 'BAD_SIGNATURE':
    case 'BAD_GRANT':
      if (!onLoginRejected()) toast(message.message, 'error');
      return;
    default:
      toast(message.message, 'error');
  }
}
