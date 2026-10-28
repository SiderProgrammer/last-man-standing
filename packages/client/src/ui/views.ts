import { formatEther, formatUnits } from 'viem';
import {
  DEFAULT_ZAP_SLIPPAGE_BPS,
  chainCss,
  chainInfo,
  joinFailureText,
  maxAmountInFor,
  type AvatarCollectionInfo,
  type CrossChainEvent,
  type LobbySeat,
  type PublicMatchState,
  type SpokeInfo,
  type ZapInfo,
  type ZapToken,
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

export function readsTable(reads: Read[]): string {
  const rows = reads
    .map(
      (read) => `
      <tr style="opacity:${read.alive ? 1 : 0.45}">
        <td>#${read.seat}</td>
        <td>${read.strikes}</td>
        <td>${read.guards}</td>
        <td>${read.charges}</td>
        <td>${read.favourite === null ? '—' : `#${read.favourite}`}</td>
        <td class="tell">${read.tell}</td>
      </tr>${
        read.past
          ? `
      <tr class="past" style="opacity:${read.alive ? 1 : 0.45}"><td></td><td colspan="5">${read.past}</td></tr>`
          : ''
      }`,
    )
    .join('');

  return `
    <table>
      <thead>
        <tr><th>seat</th><th>⚔️</th><th>🛡️</th><th>⚡</th><th>favours</th><th>tell</th></tr>
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
 * unreadable. A wallet on a spoke the server lists is not on the wrong
 * network: it stakes from there, and the chip says where its stake will go.
 */
export function hubLabel(
  hubChainId: number,
  walletChainId: number,
  hasEscrow: boolean,
  spokes: readonly SpokeInfo[] = [],
): HubLabel {
  const hub = chainInfo(hubChainId);
  const css = chainCss(hub.color);
  const elsewhere = walletChainId !== 0 && walletChainId !== hubChainId;

  if (elsewhere && hasEscrow && spokeFor(spokes, walletChainId)) {
    const spoke = chainInfo(walletChainId);
    return {
      text: `Staking from ${spoke.name} → ${hub.name} hub`,
      title:
        `Your stake is carried to ${hub.name}, where the match is held. ` +
        `Winnings and refunds are paid there, not on ${spoke.name}.`,
      mismatch: false,
      css: chainCss(spoke.color),
    };
  }

  const mismatch = elsewhere;
  if (mismatch) {
    const where = spokes.length > 0 ? ` or a spoke (${spokes.map((s) => chainInfo(s.chainId).name).join(', ')})` : '';
    return {
      text: `${hub.name} hub · wallet on ${chainInfo(walletChainId).name}`,
      title: `Switch your wallet to the hub chain${where} to stake.`,
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

// ------------------------------------------------------------ token payment

/** The "Pay with" picker: ETH first, then every token the server routes to ETH. */
export function payWithOptions(zap: ZapInfo | null): Option[] {
  return [['ETH', 'ETH'], ...(zap?.tokens ?? []).map((token): Option => [token.address, token.symbol])];
}

/** An open lobby's join button before anything has been quoted. */
export function stakeButtonLabel(stakeWei: string, token: ZapToken | null): string {
  const stake = formatEther(BigInt(stakeWei));
  return token ? `Stake ${stake} ETH in ${token.symbol}` : `Stake ${stake}`;
}

/**
 * A token amount for display, rounded *up* to `fractionDigits`.
 *
 * Up, because the figures shown are ceilings on what the player will pay: a
 * label that rounds down would promise less than the wallet then takes.
 */
export function formatTokenAmount(amount: bigint, decimals: number, fractionDigits = 4): string {
  if (decimals <= fractionDigits) return formatUnits(amount, decimals);
  const step = 10n ** BigInt(decimals - fractionDigits);
  return formatUnits(((amount + step - 1n) / step) * step, decimals);
}

export type TokenJoinPlan =
  | { ok: true; maxAmountIn: bigint; label: string }
  | { ok: false; reason: string };

/**
 * Turns a quote into the ceiling the player is asked to accept.
 *
 * The allowance for price movement is capped at the balance: nobody can pay
 * more than they hold, and a tighter ceiling only ever protects the player. A
 * balance short of the quote itself is refused here, before any wallet prompt.
 */
export function planTokenJoin(
  token: ZapToken,
  quote: bigint,
  balance: bigint,
  slippageBps: number = DEFAULT_ZAP_SLIPPAGE_BPS,
): TokenJoinPlan {
  const amount = (value: bigint) => `${formatTokenAmount(value, token.decimals)} ${token.symbol}`;
  if (balance < quote) {
    return { ok: false, reason: `This seat costs about ${amount(quote)}; you hold ${amount(balance)}.` };
  }
  const allowed = maxAmountInFor(quote, slippageBps);
  const maxAmountIn = allowed < balance ? allowed : balance;
  return { ok: true, maxAmountIn, label: `Pay ≤ ${amount(maxAmountIn)}` };
}

// ------------------------------------------------------------- spoke joins

/** The spoke the wallet is on, or null when it is on the hub or anywhere unlisted. */
export function spokeFor(spokes: readonly SpokeInfo[], walletChainId: number): SpokeInfo | null {
  return spokes.find((spoke) => spoke.chainId === walletChainId) ?? null;
}

/**
 * An open lobby's join button on a spoke, before the transport fee is known.
 * The stake is hub ETH; on a spoke that pays in another token, saying "ETH"
 * keeps "0.01" from reading as 0.01 of that token.
 */
export function spokeStakeLabel(stakeWei: string, spokeChainId: number): string {
  const unit = chainInfo(spokeChainId).native ? ' ETH' : '';
  return `Stake ${formatEther(BigInt(stakeWei))}${unit} from ${chainInfo(spokeChainId).short}`;
}

/**
 * The quoted join, as the button the player confirms. `total` is what
 * `quoteJoin` asked for, in the spoke's own gas token.
 *
 * On an ETH spoke that is the stake plus the transport fee, so the two can be
 * shown apart. On any other, the executor has priced the hub ETH it delivers
 * in that token and folded the fee in: there is no separate fee to subtract,
 * so the label shows the one figure the wallet will charge, rounded up.
 */
export function spokeQuoteLabel(stakeWei: bigint, total: bigint, spokeChainId: number): string {
  const native = chainInfo(spokeChainId).native;
  if (native) return `Pay ≤ ${formatTokenAmount(total, 18)} ${native}`;
  const fee = total > stakeWei ? total - stakeWei : 0n;
  return `Pay ${formatEther(stakeWei)} + ${formatEther(fee)} fee`;
}

/**
 * Why `quoteJoin` refused, in words. The interesting case is LayerZero's cap
 * on how much native value one message may carry: a stake above it cannot be
 * sent from this chain at all, and the raw revert says nothing of the sort.
 */
export function spokeQuoteError(message: string, spokeChainId: number): string {
  const spoke = chainInfo(spokeChainId).name;
  if (/NativeAmountExceedsCap/.test(message)) {
    return `This stake is more than LayerZero will carry from ${spoke} in one message. Join from the hub instead.`;
  }
  if (/UnknownChain/.test(message)) return `${spoke} has no route to the hub configured yet.`;
  return `Could not price the join from ${spoke}: ${message.split('\n')[0]}`;
}

/** What to tell the player when the server reports how their join landed. */
export function crossChainNotice(event: CrossChainEvent, hubChainId: number): string {
  const hub = chainInfo(hubChainId).name;
  switch (event.kind) {
    case 'seated':
      return `Your stake from ${chainInfo(event.chainId).name} arrived. Seat taken on ${hub}.`;
    case 'refunded':
      return (
        `Not seated: ${joinFailureText(event.reason)}. ` +
        `Your ${formatEther(BigInt(event.amount))} ETH is yours to collect on ${hub}.`
      );
    case 'parked':
      return (
        `Your ${formatEther(BigInt(event.amount))} ETH reached ${hub}, but the hub cannot take it yet. ` +
        'It is held safely and will be retried once the route is fixed.'
      );
  }
}
