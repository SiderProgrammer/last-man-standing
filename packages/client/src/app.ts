import { MatchPhase } from '@lms/consensus';
import { DEFAULT_SERVER_PORT, type ServerMessage } from '@lms/api';
import { app, dom, initContext, net, store } from './context.js';
import { Net } from './io/net.js';
import { hideLoader, showLoadProgress } from './screens/loading.js';
import { onCrossChain, onLobbies, onMatched, wireLobbyControls } from './screens/lobby.js';
import { onDequeued, onQueued, wireQueueControls } from './screens/queue.js';
import { refreshStaking, wireStakingPanel } from './screens/stakingPanel.js';
import { refreshGovernance, wireGovernanceNav } from './screens/governanceNav.js';
import {
  onAvatars,
  onDossier,
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
import { toast } from './ui/chrome.js';
import { queryDom } from './ui/dom.js';
import { short } from './ui/format.js';
import { httpOrigin } from './ui/staking.js';
import {
  authenticate,
  onAuthed,
  onLoginRejected,
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
  // Keeps the unstake countdown and the share price current while the page is open.
  setInterval(() => {
    refreshStaking();
    refreshGovernance();
  }, 30_000);
}

/** Routes each server message to the screen that owns it. */
function onServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'hello':
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
      });
      break;

    case 'authed':
      onAuthed();
      dom.connect.textContent = short(message.address);
      dom.connect.disabled = true;
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
      break;

    case 'lobbies':
      onLobbies(message.open, message.live);
      break;

    case 'state':
      onState(message.state, message.you, Date.now() + message.msRemaining, message.waitingFor);
      break;

    case 'delta':
      onDelta(message);
      break;

    // A match this wallet sits in has its room now: go to the table.
    case 'live':
      if (app.match?.matchId !== message.matchId) net.send({ type: 'watch', matchId: message.matchId });
      break;

    // The watch is held until the room opens; `state` follows then.
    case 'waiting':
      break;

    case 'avatars':
      onAvatars(message);
      break;

    case 'dossier':
      onDossier(message);
      break;

    case 'round':
      onRound(message);
      break;

    case 'receipt':
      void onReceipt(message);
      break;

    case 'finished':
      onFinished(message);
      break;

    case 'settled':
      void onSettled(message);
      // Archived just before this was sent, so it belongs in the list now.
      requestHistory();
      break;

    case 'history':
      onHistory(message);
      break;

    case 'review':
      onReview(message);
      break;

    case 'crossChain':
      onCrossChain(message.event);
      break;

    case 'matched':
      onDequeued();
      onMatched(message);
      break;

    case 'queued':
      onQueued(message);
      break;

    case 'dequeued':
      onDequeued();
      break;

    case 'analysis.step':
      onAnalysisStep(message);
      break;

    case 'analysis.done':
      onAnalysisDone(message);
      break;

    case 'analysis.error':
      onAnalysisError(message);
      break;

    case 'relayed':
      onRelayed(message);
      break;

    case 'balance':
      onBalance(message);
      break;

    case 'relay.error':
      onRelayError(message);
      break;

    case 'error':
      onError(message);
      break;
  }
}

function onError(message: Extract<ServerMessage, { type: 'error' }>): void {
  switch (message.code) {
    case 'BAD_SIGNATURE':
    case 'BAD_GRANT':
      if (!onLoginRejected()) toast(message.message);
      return;
    default:
      toast(message.message);
  }
}
