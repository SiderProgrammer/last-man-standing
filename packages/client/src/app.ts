import { MatchPhase, type ServerMessage } from '@lms/protocol';
import { loadAssets } from './assets/loader.js';
import { app, dom, initContext, net } from './context.js';
import { Net } from './io/net.js';
import { hideLoader, showLoadProgress } from './screens/loading.js';
import { renderLobbies, renderPayWith, wireLobbyControls } from './screens/lobby.js';
import {
  onAvatars,
  onFinished,
  onRound,
  onState,
  updateTimer,
  wireMatchControls,
} from './screens/match.js';
import { toast } from './ui/chrome.js';
import { queryDom } from './ui/dom.js';
import { short } from './ui/format.js';
import {
  authenticate,
  renderAvatarPanel,
  renderHubLabel,
  renderSessionPanel,
  wireWalletControls,
} from './wallet/flows.js';

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
  setInterval(updateTimer, 200);
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
      renderPayWith();
      renderHubLabel();
      renderSessionPanel();
      void renderAvatarPanel();
      dom.createLobby.disabled = !message.escrow;
      break;

    case 'authed':
      dom.connect.textContent = short(message.address);
      dom.connect.disabled = true;
      net.flush();
      net.send({ type: 'lobbies' });
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
      onState(message.state, message.you, message.deadline, message.chips, message.book);
      break;

    case 'avatars':
      onAvatars(message);
      break;

    case 'round':
      onRound(message);
      break;

    case 'finished':
      onFinished(message);
      break;

    case 'relayed':
      toast(`Sent without a wallet prompt · ${short(message.hash)}`);
      net.send({ type: 'lobbies' });
      void renderAvatarPanel();
      break;

    case 'error':
      toast(message.message);
      break;
  }
}
