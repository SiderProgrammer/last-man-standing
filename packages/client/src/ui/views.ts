import { formatEther, formatUnits } from 'viem';
import { type PublicMatchState } from '@lms/consensus';
import {
  DEFAULT_ZAP_SLIPPAGE_BPS,
  MatchStatus,
  chainCss,
  chainInfo,
  joinFailureText,
  maxAmountInFor,
} from '@lms/contracts';
import {
  type AvatarCollectionInfo,
  type CrossChainEvent,
  type LobbyInfo,
  type LobbySeat,
  type MatchmakingTier,
  type SpokeInfo,
  type ZapInfo,
  type ZapToken,
} from '@lms/api';
import { formatDuration } from './staking.js';

/**
 * Pure builders for everything the panels display.
 *
 * Each takes state and returns rows, options or text; none of them touches
 * the document, and none returns markup: the screens build nodes from what
 * these return, so nothing reaches the page through `innerHTML`. That is
 * what lets the interesting parts of the UI be tested in node, with the DOM
 * writes left as a thin applier layer in `screens/`.
 */

/** A `<select>` option, as value and label. */
export type Option = [value: string, label: string];

/** Where this wallet is in the matchmaking queue, as the server last said. */
export interface QueueSpot {
  stake: string;
  seats: number;
  /** Wallets in that tier now, this one included. */
  waiting: number;
}

export interface QueuePanel {
  visible: boolean;
  /** The tiers, each `stake:seats`, labelled with the stake in ETH and the table size. */
  tiers: Option[];
  pill: string;
  joinVisible: boolean;
  joinDisabled: boolean;
  leaveVisible: boolean;
  status: string;
}

/** Elapsed time as a clock, "0:42" or "12:05": for waits the player watches tick. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The tier a queue option stands for. */
export function tierKey(tier: MatchmakingTier): string {
  return `${tier.stake}:${tier.seats}`;
}

/**
 * The matchmaking panel. Shown only when the server matchmakes: its tiers
 * are the only tables that earn play-mining, and the queue is the only way
 * into them.
 */
export function queuePanel(
  tiers: readonly MatchmakingTier[],
  connected: boolean,
  spot: QueueSpot | null,
  terms: Pick<ProtocolTerms, 'feeBps' | 'payoutBps'> | null = null,
  /** A table the queue put this wallet at that still waits for its stake. */
  ready: { stake: string; seats: number; closesIn: number | null } | null = null,
): QueuePanel {
  const options: Option[] = tiers.map((tier) => {
    const prize = prizeSummary(tier.stake, tier.seats, terms);
    return [tierKey(tier), `${formatEther(BigInt(tier.stake))} ETH · ${tier.seats} seats${prize ? ` · ${prize}` : ''}`];
  });
  const base = { visible: tiers.length > 0, tiers: options };
  if (ready) {
    const left = ready.closesIn !== null && ready.closesIn > 0 ? ` · ${formatDuration(ready.closesIn)} left` : '';
    return {
      ...base,
      pill: 'table ready',
      joinVisible: false,
      joinDisabled: true,
      leaveVisible: false,
      status: `Your ${ready.seats}-seat table is ready. Stake ${formatEther(BigInt(ready.stake))} ETH in its row below to take your seat${left}.`,
    };
  }
  if (spot) {
    const others = spot.waiting - 1;
    return {
      ...base,
      pill: 'queued',
      joinVisible: false,
      joinDisabled: true,
      leaveVisible: true,
      status:
        `Waiting for a ${spot.seats}-seat table at ${formatEther(BigInt(spot.stake))} ETH · ` +
        (others <= 0 ? 'nobody else queued yet' : `${others} other${others === 1 ? '' : 's'} queued`),
    };
  }
  return {
    ...base,
    pill: 'idle',
    joinVisible: true,
    joinDisabled: !connected,
    leaveVisible: false,
    status: connected
      ? 'When a table fills, its lobby opens for exactly those players; stake into it to take your seat.'
      : 'Connect a wallet to queue.',
  };
}

export function targetOptions(state: PublicMatchState, you: number | null): Option[] {
  return state.players
    .filter((player) => player.alive && player.index !== you)
    .map((player) => [String(player.index), `#${player.index}`]);
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

/** One chip in a lobby row: a chain, and how many seats came from it. */
export interface ChainChip {
  label: string;
  title: string;
  /** Value for the chip's `--chain` custom property. */
  css: string;
}

export function chainChips(seats: readonly LobbySeat[]): ChainChip[] {
  return chainChipCounts(seats).map(([chainId, count]) => {
    const chain = chainInfo(chainId);
    return { label: count > 1 ? `${chain.short} ×${count}` : chain.short, title: chain.name, css: chainCss(chain.color) };
  });
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

/** A lobby row's text: its stake, how full it is, and its status. */
export function lobbySummary(stake: string, seatCount: number, maxSeats: number, status: string): string {
  return `${formatEther(BigInt(stake))} ETH · ${seatCount}/${maxSeats} seats · ${status}`;
}

/**
 * The directory in the order a player scans it: their own tables first, then
 * the fullest, which start soonest. Stable otherwise.
 */
export function sortLobbies<T extends Pick<LobbyInfo, 'seatCount' | 'maxSeats'>>(
  lobbies: readonly T[],
  yours: (lobby: T) => boolean,
): T[] {
  const fill = (lobby: T) => lobby.seatCount / Math.max(1, lobby.maxSeats);
  return [...lobbies].sort((a, b) => Number(yours(b)) - Number(yours(a)) || fill(b) - fill(a));
}

/** A lobby row's second line: how full it is, and for an open one, how long it stays open. */
export function lobbySeatsText(
  lobby: Pick<LobbyInfo, 'seatCount' | 'maxSeats' | 'minSeats' | 'status' | 'joinDeadline'>,
  nowSeconds: number,
): string {
  const seats = `${lobby.seatCount}/${lobby.maxSeats} seats`;
  if (lobby.status !== 'open') return seats;
  const left = lobby.joinDeadline - nowSeconds;
  const needs = lobby.seatCount < lobby.minSeats ? ` · needs ${lobby.minSeats - lobby.seatCount} more to start` : '';
  return left > 0 ? `${seats}${needs} · closes in ${formatDuration(left)}` : `${seats} · join window closed`;
}

/**
 * What a lobby row's button does for this wallet. A seat in a lobby that can
 * now only be cancelled offers the refund; a lobby whose join window has
 * closed takes no new seats, whatever the directory last said.
 */
export function lobbyAction(
  lobby: Pick<LobbyInfo, 'status' | 'joinDeadline' | 'cancellableAt' | 'matchmade'>,
  seated: boolean,
  nowSeconds: number,
  /** The queue put this wallet in it: see `app.matched`. */
  matched = false,
): 'cancel' | 'enter' | 'watch' | 'closed' | 'matchmade' | 'join' {
  if (seated && nowSeconds >= lobby.cancellableAt) return 'cancel';
  if (seated) return 'enter';
  if (lobby.status !== 'open') return 'watch';
  if (nowSeconds >= lobby.joinDeadline) return 'closed';
  return lobby.matchmade && !matched ? 'matchmade' : 'join';
}

// ------------------------------------------------------------------- prizes

/**
 * What a finishing place pays, exactly as `GameEscrow._distribute` credits
 * it: the full pool, less the fee, split by the schedule fixed when the
 * lobby opened. Zero for a place the schedule does not pay.
 */
export function prizeFor(
  terms: { stake: bigint; seatCount: number; feeBps: number; payoutBps: readonly number[] },
  place: number,
): bigint {
  const share = terms.payoutBps[place];
  if (share === undefined || place < 0) return 0n;
  const pool = terms.stake * BigInt(terms.seatCount);
  const distributable = pool - (pool * BigInt(terms.feeBps)) / 10_000n;
  return (distributable * BigInt(share)) / 10_000n;
}

/**
 * The result panel's line about the money: what this place won and when it
 * can be collected. Null for a place that won nothing, so the line is hidden.
 */
export function prizeLine(
  prize: bigint,
  match: { status: number; deadline: number; chainTime: number },
  formatWait: (seconds: number) => string,
): string | null {
  if (prize === 0n) return null;
  const won = `You won ${formatEther(prize)} ETH`;
  switch (match.status) {
    case MatchStatus.Settled:
      return `${won}. It is in your balance: collect it below or from the lobby.`;
    case MatchStatus.Proposed:
      return match.chainTime >= match.deadline
        ? `${won}. The challenge window is over: it is yours to collect as soon as the result is finalised.`
        : `${won}. Collectable once the challenge window closes, in ${formatWait(match.deadline - match.chainTime)}.`;
    case MatchStatus.Cancelled:
      return null;
    default:
      return `${won}. Collectable once the result is settled on-chain and its challenge window closes.`;
  }
}

// ------------------------------------------------------------ money clarity

/** What a new lobby opens on, as `ProtocolConfig` has it now: see `wallet/terms.ts`. */
export interface ProtocolTerms {
  feeBps: number;
  payoutBps: readonly number[];
  minStake: bigint;
  maxStake: bigint;
  /** Seconds a proposed result waits before it pays out. */
  challengeWindow: number;
}

/**
 * An ETH amount rounded to `digits` decimals, half up, without trailing
 * zeros. Rounded rather than cut: 0.99999 reads as 1, not 0.99, and a dust
 * amount reads as "<0.000001" rather than a 0 that still has a button.
 */
export function formatEth(wei: bigint, digits = 6): string {
  if (wei === 0n) return '0';
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const step = 10n ** BigInt(18 - digits);
  const rounded = ((abs + step / 2n) / step) * step;
  if (rounded === 0n) return `${negative ? '>-' : '<'}0.${'0'.repeat(digits - 1)}1`;
  return `${negative ? '-' : ''}${formatEther(rounded)}`;
}

/**
 * What a full table pays: the pot and the top prize, as `prizeFor` works
 * them out. "Pot 0.004 · 1st 0.00228". Null without terms to work from.
 */
export function prizeSummary(
  stakeWei: string | bigint,
  seats: number,
  terms: { feeBps: number; payoutBps: readonly number[] } | null | undefined,
): string | null {
  if (!terms || terms.payoutBps.length === 0) return null;
  const stake = BigInt(stakeWei);
  const pot = stake * BigInt(seats);
  const first = prizeFor({ stake, seatCount: seats, feeBps: terms.feeBps, payoutBps: terms.payoutBps }, 0);
  return `Pot ${formatEth(pot)} · 1st ${formatEth(first)}`;
}

/** The longer form, for a tooltip: every paying place and the fee. */
export function prizeBreakdown(
  stakeWei: string | bigint,
  seats: number,
  terms: { feeBps: number; payoutBps: readonly number[] },
): string {
  const stake = BigInt(stakeWei);
  const places = terms.payoutBps
    .map((_, place) => prizeFor({ stake, seatCount: seats, feeBps: terms.feeBps, payoutBps: terms.payoutBps }, place))
    .map((prize, place) => `${ordinalPlace(place + 1)} ${formatEth(prize)} ETH`);
  return `With all ${seats} seats taken: ${places.join(' · ')} · ${terms.feeBps / 100}% fee`;
}

function ordinalPlace(value: number): string {
  return value === 1 ? '1st' : value === 2 ? '2nd' : value === 3 ? '3rd' : `${value}th`;
}

/** The stakes the create form accepts: "0.001 – 1 ETH". */
export function stakeRangeText(terms: Pick<ProtocolTerms, 'minStake' | 'maxStake'>): string {
  return `${formatEther(terms.minStake)} – ${formatEther(terms.maxStake)} ETH`;
}

export type StakeInput = { ok: true; wei: bigint } | { ok: false; error: string };

/**
 * A stake typed into the create form, or why it is not one. Takes a decimal
 * comma ("0,005") as readily as a point, and checks the range the config
 * allows before the wallet is asked anything.
 */
export function parseStakeInput(text: string, terms: Pick<ProtocolTerms, 'minStake' | 'maxStake'> | null): StakeInput {
  const normalised = text.trim().replace(',', '.');
  if (normalised === '') return { ok: false, error: 'Enter a stake in ETH, e.g. 0.001.' };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(normalised)) return { ok: false, error: `"${text.trim()}" is not an amount of ETH.` };
  const [whole = '0', fraction = ''] = normalised.split('.');
  if (fraction.length > 18) return { ok: false, error: 'At most 18 decimals.' };
  const wei = BigInt(whole || '0') * 10n ** 18n + BigInt((fraction || '0').padEnd(18, '0'));
  if (wei === 0n) return { ok: false, error: 'The stake must be more than 0.' };
  if (terms && (wei < terms.minStake || wei > terms.maxStake)) {
    return { ok: false, error: `Stakes run from ${stakeRangeText(terms)}.` };
  }
  return { ok: true, wei };
}

/** A prize this wallet has won that is not in its balance yet. */
export interface PendingPrize {
  matchId: `0x${string}`;
  amount: bigint;
  /** Seconds until the challenge window closes; zero once it has. */
  unlocksIn: number;
}

/** The Winnings line for prizes still in their challenge window. */
export function pendingPrizesText(pending: readonly PendingPrize[], formatWait: (seconds: number) => string): string {
  if (pending.length === 0) return '';
  const total = pending.reduce((sum, prize) => sum + prize.amount, 0n);
  const soonest = Math.min(...pending.map((prize) => prize.unlocksIn));
  const when = soonest > 0 ? `unlocking in ${formatWait(soonest)}` : 'paying out once it is finalised';
  return pending.length === 1
    ? `${formatEth(total)} ETH on its way, ${when}.`
    : `${formatEth(total)} ETH on its way from ${pending.length} matches, the first ${when}.`;
}

/**
 * The header's winnings badge: what is waiting to be collected, or on its
 * way. Null hides it.
 */
export function winningsBadge(owed: bigint, pending: readonly PendingPrize[]): string | null {
  if (owed > 0n) return `${formatEth(owed)} ETH to collect`;
  const coming = pending.reduce((sum, prize) => sum + prize.amount, 0n);
  return coming > 0n ? `${formatEth(coming)} ETH unlocking` : null;
}

/** A block explorer page for a transaction, or null on a chain without a public one. */
export function explorerTxUrl(chainId: number, hash: string): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${hash}` : null;
}

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  11155111: 'https://sepolia.etherscan.io',
  84532: 'https://sepolia.basescan.org',
  421614: 'https://sepolia.arbiscan.io',
  11155420: 'https://sepolia-optimism.etherscan.io',
};

// ------------------------------------------------------------ token payment

/** The "Pay with" picker: ETH first, then every token the server routes to ETH. */
export function payWithOptions(zap: ZapInfo | null): Option[] {
  return [['ETH', 'ETH'], ...(zap?.tokens ?? []).map((token): Option => [token.address, token.symbol])];
}

/** The LMS fee discount, as governance has set it, and this wallet's LMS. */
export interface DiscountTerms {
  /** The LMS token, which the escrow takes the discount's LMS in. */
  token: `0x${string}`;
  /** LMS per ETH of fee taken off, 18 decimals. */
  rate: bigint;
  /** LMS this wallet holds. */
  balance: bigint;
}

/**
 * The line under the "pay part of the fee in LMS" option, and whether it can
 * be ticked at all. Null terms hide the option: the discount is off.
 */
export function discountStatus(terms: DiscountTerms): { text: string; enabled: boolean } {
  const rate = `${formatTokenAmount(terms.rate, 18, 0)} LMS buys 1 ETH off a fee, up to half of each fee`;
  if (terms.balance === 0n) return { text: `${rate} · you hold no LMS`, enabled: false };
  return { text: `${rate} · you hold ${formatTokenAmount(terms.balance, 18, 2)} LMS`, enabled: true };
}

/** A join priced with the discount: the ETH sent and the LMS spent, which the second click pays. */
export function discountJoinLabel(stakeWei: string, quote: { discount: bigint; lmsUsed: bigint }): string {
  const eth = formatEther(BigInt(stakeWei) - quote.discount);
  return `Pay ${eth} ETH + ${formatTokenAmount(quote.lmsUsed, 18, 2)} LMS`;
}

export type CollectHomePlan = { ok: true; label: string; detail: string } | { ok: false; reason: string };

/**
 * A priced withdrawal of the whole hub balance to a spoke, or why there is
 * none: nothing held, or less than the receiver bridges. `amount` is the
 * balance and `output` what Across delivers for it.
 */
export function collectHomePlan(
  amount: bigint,
  minimum: bigint,
  output: bigint,
  spokeChainId: number,
  hubChainId: number,
): CollectHomePlan {
  const hub = chainInfo(hubChainId).name;
  if (amount === 0n) return { ok: false, reason: `Nothing waiting for you on ${hub}.` };
  if (amount < minimum) {
    return {
      ok: false,
      reason: `${formatEther(amount)} ETH is under the ${formatEther(minimum)} ETH that can be bridged; switch to ${hub} to collect it there.`,
    };
  }
  return {
    ok: true,
    label: `Receive ${formatEther(output)} ETH on ${chainInfo(spokeChainId).name}`,
    detail: `${formatEther(amount)} ETH on ${hub}, less ${formatEther(amount - output)} ETH to the bridge. Click again to sign.`,
  };
}

/** An open lobby's join button before anything has been quoted. */
export function stakeButtonLabel(stakeWei: string, token: ZapToken | null): string {
  const stake = formatEther(BigInt(stakeWei));
  return token ? `Stake ${stake} ETH in ${token.symbol}` : `Stake ${stake} ETH`;
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

/** An open lobby's join button on a spoke, before the bridge fee is known. */
export function spokeStakeLabel(stakeWei: string, spokeChainId: number): string {
  return `Stake ${formatEther(BigInt(stakeWei))} ETH from ${chainInfo(spokeChainId).short}`;
}

/**
 * The quoted join, as the button the player confirms: the stake, which is
 * what arrives on the hub, and Across's fee on top of it.
 */
export function spokeQuoteLabel(stakeWei: bigint, total: bigint): string {
  const fee = total > stakeWei ? total - stakeWei : 0n;
  return fee === 0n
    ? `Pay ${formatEther(stakeWei)} ETH`
    : `Pay ${formatEther(stakeWei)} + ${formatEther(fee)} ETH fee`;
}

/**
 * Why a join could not be priced or sent, in words. The interesting cases
 * are a contract wallet, which the router will not seat as itself because
 * its address may be someone else's on the hub, and an amount Across will
 * not move.
 */
export function spokeQuoteError(message: string, spokeChainId: number): string {
  const spoke = chainInfo(spokeChainId).name;
  if (/HubRecipientRequired/.test(message)) {
    return `A contract wallet cannot join from ${spoke} as itself. Join from the hub instead.`;
  }
  if (/amount this small/.test(message)) return `This stake is below what Across will bridge from ${spoke}.`;
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
  }
}
