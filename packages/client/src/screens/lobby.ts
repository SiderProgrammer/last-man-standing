import { encodeFunctionData, formatEther } from 'viem';
import { errorFirstLine, gameEscrowAbi, sameAddress, type LobbyInfo } from '@lms/protocol';
import { app, dom, net } from '../context.js';
import { showMatchScreen, toast } from '../ui/chrome.js';
import { short } from '../ui/format.js';
import { lobbySummary } from '../ui/views.js';
import { relayCall } from '../wallet/flows.js';

/** The lobby screen: practice, the staked-lobby directory, create and join. */

export function wireLobbyControls(): void {
  dom.practice.onclick = () => {
    net.send({ type: 'practice', bots: Number(dom.botCount.value) });
  };

  dom.refreshLobbies.onclick = () => net.send({ type: 'lobbies' });
  dom.createLobby.onclick = () => void createLobby();
}

export function renderLobbies(open: LobbyInfo[], live: LobbyInfo[]): void {
  if (open.length === 0 && live.length === 0) {
    dom.lobbyList.innerHTML = app.escrow
      ? '<li class="muted small">No staked lobbies yet. Create one above.</li>'
      : '<li class="muted small">Server is running without an escrow: practice only.</li>';
    return;
  }

  dom.lobbyList.replaceChildren(
    ...open.map((lobby) => lobbyRow(lobby, true)),
    ...live.map((lobby) => lobbyRow(lobby, false)),
  );
}

function lobbyRow(lobby: LobbyInfo, joinable: boolean): HTMLLIElement {
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.innerHTML = lobbySummary(
    lobby.matchId,
    lobby.stake,
    lobby.seatCount,
    lobby.maxSeats,
    lobby.status,
    lobby.players,
    short,
  );

  const button = document.createElement('button');
  const seated = lobby.players.some((player) => sameAddress(player.address, app.wallet?.address));

  if (seated || !joinable) {
    button.textContent = seated ? 'Enter' : 'Watch';
    button.onclick = () => {
      net.send({ type: 'watch', matchId: lobby.matchId });
      showMatchScreen();
    };
  } else {
    button.textContent = `Stake ${formatEther(BigInt(lobby.stake))}`;
    button.onclick = () => void joinLobby(lobby);
  }

  li.append(label, button);
  return li;
}

async function createLobby(): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.');
  try {
    dom.createLobby.disabled = true;
    const hash = await wallet.createMatch(escrow, dom.stake.value, Number(dom.seats.value));
    await wallet.waitFor(hash);
    // Creating does not seat you: join explicitly so the stake is escrowed.
    net.send({ type: 'lobbies' });
    toast('Lobby created. Stake into it to take a seat.');
  } catch (error) {
    toast(errorFirstLine(error));
  } finally {
    dom.createLobby.disabled = false;
  }
}

async function joinLobby(lobby: LobbyInfo): Promise<void> {
  const { wallet, escrow } = app;
  if (!wallet || !escrow) return toast('Connect a wallet first.');

  // The session key covers `join`, so a staked seat costs no prompt at all.
  const relayed = await relayCall(
    escrow,
    BigInt(lobby.stake),
    encodeFunctionData({ abi: gameEscrowAbi, functionName: 'join', args: [lobby.matchId] }),
  );
  if (relayed) {
    // No `watch` yet: the relay is still in flight, and the room does not exist
    // until the lobby fills and the oracle seeds it. The `relayed` reply
    // refreshes the directory, and the row turns into an Enter button.
    toast('Seat requested. The match starts when the lobby fills.');
    return;
  }

  try {
    const hash = await wallet.join(escrow, lobby.matchId, BigInt(lobby.stake));
    await wallet.waitFor(hash);
    net.send({ type: 'lobbies' });
    // The server opens the room once the lobby locks and the oracle seeds it.
    net.send({ type: 'watch', matchId: lobby.matchId });
    toast('Seat taken. The match starts when the lobby fills.');
  } catch (error) {
    toast(errorFirstLine(error));
  }
}
