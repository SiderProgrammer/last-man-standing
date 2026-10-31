import { DEFAULT_SERVER_PORT, MatchPhase, type ServerMessage } from '@lms/protocol';
import { loadAssets } from './assets/loader.js';
import { app, dom, initContext, net } from './context.js';
import { Net } from './io/net.js';
import { hideLoader, showLoadProgress } from './screens/loading.js';
import { onCrossChain, renderLobbies, renderPayWith, wireLobbyControls } from './screens/lobby.js';
import { renderStakingPanel, wireStakingControls } from './screens/staking.js';
import {
  governanceVisible,
  renderGovernance,
  renderGovernanceNav,
  wireGovernanceControls,
} from './screens/governance.js';
import {
  onAvatars,
  onDossier,
  onFinished,
  onReceipt,
  onRound,
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
  renderAvatarPanel,
  renderHubLabel,
  renderSessionPanel,
  wireWalletControls,
} from './wallet/flows.js';
import { renderWinnings, wirePayoutControls } from './wallet/payouts.js';
import { onRelayError, onRelayed, renderOneClickPanel, wireOneClickControls } from './wallet/oneClick.js';

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
  void loadAssets(showLoadProgress).then(hideLoader);

  net.on(onServerMessage);
  net.connect();
  wireWalletControls();
  wireOneClickControls();
  wireLobbyControls();
  wireMatchControls();
  wirePayoutControls();
  wireResultControls(httpOrigin(SERVER_URL));
  wireHelpControls();
  wireHistoryControls();
  wireStakingControls();
  wireGovernanceControls(httpOrigin(SERVER_URL));
  setInterval(updateTimer, 200);
  // Keeps the unstake countdown and the share price current while the page is open.
  setInterval(() => {
    if (app.wallet && app.staking) void renderStakingPanel();
    if (governanceVisible()) void renderGovernance();
  }, 30_000);
}

/** Routes each server message to the screen that owns it. */
function onServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'hello':
      app.nonce = message.nonce;
      app.chainId = message.chainId;
      app.escrow = message.escrow;
      app.avatarCollections = message.avatarCollections;
      app.sessionDelegate = message.sessionDelegate;
      app.relayQuota = message.relayQuota;
      app.receiptSigner = message.receiptSigner;
      app.zap = message.zap;
      app.spokes = message.spokes ?? [];
      app.staking = message.staking;
      app.analyst = message.analyst ?? false;
      renderPayWith();
      renderHubLabel();
      renderSessionPanel();
      renderOneClickPanel();
      void renderAvatarPanel();
      void renderStakingPanel();
      renderGovernanceNav();
      break;

    case 'authed':
      onAuthed();
      dom.connect.textContent = short(message.address);
      dom.connect.disabled = true;
      net.flush();
      net.send({ type: 'lobbies' });
      requestHistory();
      void renderWinnings();
      void renderStakingPanel();
      if (governanceVisible()) void renderGovernance();
      // A reconnect drops the socket, not the seat: ask to be re-attached to the
      // match that is still running on the server.
      if (app.match && app.match.phase !== MatchPhase.Finished) {
        net.send({ type: 'watch', matchId: app.match.matchId });
      }
      break;

    case 'lobbies':
      renderLobbies(message.open, message.live);
      break;

    case 'state':
      onState(message.state, message.you, message.deadline);
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
