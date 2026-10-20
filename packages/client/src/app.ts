import { MatchPhase, type ServerMessage } from '@lms/protocol';
import { loadAssets } from './assets/loader.js';
import { app, dom, initContext, net } from './context.js';
import { Net } from './io/net.js';
import { hideLoader, showLoadProgress } from './screens/loading.js';
import { renderLobbies, renderPayWith, wireLobbyControls } from './screens/lobby.js';
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
  onRound,
  onState,
  updateTimer,
  wireMatchControls,
} from './screens/match.js';
import { onSettled, wireResultControls } from './screens/result.js';
import {
  onAnalysisDone,
  onAnalysisError,
} from './screens/analysis.js';
import { toast } from './ui/chrome.js';
import { queryDom } from './ui/dom.js';
import { short } from './ui/format.js';
import { httpOrigin } from './ui/staking.js';
import {
  authenticate,
  renderAvatarPanel,
  renderHubLabel,
  renderSessionPanel,
  wireWalletControls,
} from './wallet/flows.js';
import { renderWinnings, wirePayoutControls } from './wallet/payouts.js';

const SERVER_URL = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8787`;

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
  wireLobbyControls();
  wireMatchControls();
  wirePayoutControls();
  wireResultControls();
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
      app.zap = message.zap;
      app.collect = message.collect;
      app.staking = message.staking;
      app.analyst = message.analyst ?? false;
      renderPayWith();
      renderHubLabel();
      renderSessionPanel();
      void renderAvatarPanel();
      void renderStakingPanel();
      renderGovernanceNav();
      dom.createLobby.disabled = !message.escrow;
      break;

    case 'authed':
      dom.connect.textContent = short(message.address);
      dom.connect.disabled = true;
      net.flush();
      net.send({ type: 'lobbies' });
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

    case 'finished':
      onFinished(message);
      break;

    case 'settled':
      void onSettled(message);
      break;

    case 'relayed':
      toast(`Sent without a wallet prompt · ${short(message.hash)}`);
      net.send({ type: 'lobbies' });
      void renderAvatarPanel();
      // A pushed payout is a relayed transaction too; re-read once it lands.
      void app.wallet?.waitFor(message.hash).then(renderWinnings, renderWinnings);
      break;

    case 'analysis.done':
      onAnalysisDone(message);
      break;

    case 'analysis.error':
      onAnalysisError(message);
      break;

    case 'error':
      toast(message.message);
      break;
  }
}
