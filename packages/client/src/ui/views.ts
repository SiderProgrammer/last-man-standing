import { formatEther } from 'viem';
import {
  chainCss,
  chainInfo,
  type AvatarCollectionInfo,
  type BookSnapshot,
  type LobbySeat,
  type PublicMatchState,
} from '@lms/protocol';
import type { Read } from '../game/reads.js';

/**
 * Pure builders for everything the panels display.
 *
 * Each takes state and returns rows, options or markup; none of them touches
 * the document. That is what lets the interesting parts of the UI be tested in
 * node, with the DOM writes left as a thin applier layer in `screens/`.
 */

/** A `<select>` option, as value and label. */
export type Option = [value: string, label: string];

export function targetOptions(state: PublicMatchState, you: number | null): Option[] {
  return state.players
    .filter((player) => player.alive && player.index !== you)
    .map((player) => [String(player.index), `#${player.index}`]);
}

export function betTargetOptions(state: PublicMatchState, you: number | null): Option[] {
  return state.players
    .filter((player) => player.alive)
    .map((player) => [
      String(player.index),
      player.index === you ? `#${player.index} (you)` : `#${player.index}`,
    ]);
}

export interface BookRow {
  seat: string;
  chips: number;
  /** Display odds, or an em dash when the pot is empty. */
  odds: string;
  /** This viewer's stake on the seat; zero when they have none. */
  yours: number;
}

/**
 * The round book, richest pot first.
 *
 * These odds are a display figure — total pot over the stake on one seat — and
 * are deliberately *not* the settlement maths in `@lms/protocol`'s
 * `settleEliminationBook`, which divides the pot among winning tickets. The two
 * look alike and are different functions; merging them would change payouts.
 */
export function bookRows(book: BookSnapshot): BookRow[] {
  const entries = Object.entries(book.pots).sort((a, b) => Number(b[1]) - Number(a[1]));
  const total = entries.reduce((sum, [, chips]) => sum + chips, 0);

  return entries.map(([seat, chips]) => ({
    seat,
    chips,
    odds: total > 0 ? (total / chips).toFixed(2) : '—',
    yours: book.yours[Number(seat)] ?? 0,
  }));
}

export function readsTable(reads: Read[]): string {
  const rows = reads
    .map(
      (read) => `
      <tr style="opacity:${read.alive ? 1 : 0.45}">
        <td>#${read.seat}</td>
        <td>${read.attacks}</td>
        <td>${read.defends}</td>
        <td>${read.hides}</td>
        <td>${read.favourite === null ? '—' : `#${read.favourite}`}</td>
        <td class="tell">${read.tell}</td>
      </tr>`,
    )
    .join('');

  return `
    <table>
      <thead>
        <tr><th>seat</th><th>⚔️</th><th>🛡️</th><th>🏃</th><th>favours</th><th>tell</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Seats grouped by the chain they staked from, busiest first.
 *
 * Per chain rather than per seat: eight identical Sepolia chips say nothing,
 * whereas "three spokes feeding this pool" is the point.
 */
export function chainChipCounts(seats: readonly LobbySeat[]): Array<[chainId: number, count: number]> {
  const counts = new Map<number, number>();
  for (const seat of seats) counts.set(seat.chainId, (counts.get(seat.chainId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

export function chainChips(seats: readonly LobbySeat[]): string {
  const counts = chainChipCounts(seats);
  if (counts.length === 0) return '';

  const chips = counts
    .map(([chainId, count]) => {
      const chain = chainInfo(chainId);
      const suffix = count > 1 ? ` ×${count}` : '';
      return (
        `<span class="chain-chip" style="--chain:${chainCss(chain.color)}" title="${chain.name}">` +
        `${chain.short}${suffix}</span>`
      );
    })
    .join('');

  return `<span class="chain-chips">${chips}</span>`;
}

export interface HubLabel {
  text: string;
  title: string;
  /** True when the wallet is pointed at a chain other than the hub. */
  mismatch: boolean;
  css: string;
}

/**
 * The hub chip, plus the warning state when the wallet is elsewhere.
 *
 * Worth surfacing because a player on the wrong network can read every lobby
 * while every stake they place reverts, and the wallet's own error for that is
 * unreadable.
 */
export function hubLabel(hubChainId: number, walletChainId: number, hasEscrow: boolean): HubLabel {
  const hub = chainInfo(hubChainId);
  const css = chainCss(hub.color);
  const mismatch = walletChainId !== 0 && walletChainId !== hubChainId;

  if (mismatch) {
    return {
      text: `${hub.name} hub · wallet on ${chainInfo(walletChainId).name}`,
      title: 'Switch your wallet to the hub chain to stake directly, or join from a spoke.',
      mismatch,
      css,
    };
  }

  return {
    text: hasEscrow ? `${hub.name} hub` : `${hub.name} · practice only`,
    title: `Hub chain ${hubChainId}`,
    mismatch,
    css,
  };
}

export interface AvatarStatus {
  equipped: bigint;
  minted: boolean;
  totalMinted: bigint;
  maxSupply: bigint;
}

export interface AvatarPanel {
  mintDisabled: boolean;
  status: string;
}

/**
 * What the avatar panel says, given what the wallet owns on its own chain.
 *
 * Split from the read so the cascade can be tested without a chain: the caller
 * does the `avatarStatus` call and hands the answer here.
 */
export function avatarPanel(
  wallet: boolean,
  collection: AvatarCollectionInfo | null,
  walletChainId: number,
  collectionsConfigured: number,
  status: AvatarStatus | null,
): AvatarPanel {
  if (!wallet) return { mintDisabled: true, status: 'Connect a wallet to check.' };

  if (!collection) {
    return {
      mintDisabled: true,
      status:
        collectionsConfigured === 0
          ? 'No avatar collection configured on this server.'
          : `No collection on ${chainInfo(walletChainId).name}. Switch chains to mint.`,
    };
  }

  if (!status) return { mintDisabled: true, status: 'Connect a wallet to check.' };

  const supply = `${status.totalMinted}/${status.maxSupply} minted`;
  if (status.equipped > 0n) return { mintDisabled: true, status: `Wearing #${status.equipped} · ${supply}` };
  if (status.minted) return { mintDisabled: true, status: `You own one but wear none · ${supply}` };
  if (status.totalMinted >= status.maxSupply) return { mintDisabled: true, status: `Sold out · ${supply}` };
  return { mintDisabled: false, status: `Free, one per wallet · ${supply}` };
}

/** The lobby row's left-hand label. */
export function lobbySummary(
  matchId: string,
  stake: string,
  seatCount: number,
  maxSeats: number,
  status: string,
  seats: readonly LobbySeat[],
  shorten: (value: string) => string,
): string {
  return (
    `<strong>${shorten(matchId)}</strong> ` +
    `<span class="muted small">${formatEther(BigInt(stake))} ETH · ` +
    `${seatCount}/${maxSeats} seats · ${status}</span>` +
    chainChips(seats)
  );
}
