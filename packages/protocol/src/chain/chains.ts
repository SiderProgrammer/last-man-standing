/**
 * Chain identity, shared by the server and the client.
 *
 * Two id spaces meet in this file and they are not the same thing. An EVM chain
 * id (`1`, `8453`, `11155111`) is what a wallet reports and what a block
 * explorer keys on. A transport endpoint id — LayerZero v2's `eid` — is what
 * the messenger speaks on the wire. `LayerZeroMessenger` translates eids to
 * chain ids before the escrow sees them, so `GameEscrow.seatOrigin` holds a
 * chain id, or zero for a stake placed on the hub; `originChainId` turns that
 * into the chain a `Seat` shows.
 */

/** Seat origin used by practice matches, which never touch a chain. */
export const PRACTICE_CHAIN_ID = 0;

export interface ChainInfo {
  chainId: number;
  /** LayerZero v2 endpoint id, where the chain is reachable as a spoke. */
  eid?: number;
  name: string;
  /** Short label for the arena badge, where there is room for about five characters. */
  short: string;
  /**
   * Badge colour as `0xRRGGBB`. Pixi wants the number and CSS wants the hex
   * string, so it is stored in the form both can be derived from.
   */
  color: number;
  testnet: boolean;
  /**
   * Symbol of the chain's gas token, where it is not ETH. A spoke join is
   * paid in it: LayerZero's executor prices the hub ETH it delivers in the
   * spoke's own token.
   */
  native?: string;
}

const UNKNOWN_COLOR = 0x6b7689;

/**
 * Chains the client knows how to label. An unlisted chain still renders — it
 * falls back to its numeric id — so a new spoke works before this table does.
 */
export const CHAINS: readonly ChainInfo[] = [
  { chainId: PRACTICE_CHAIN_ID, name: 'Practice', short: 'PRAC', color: 0x6b7689, testnet: false },

  { chainId: 1, eid: 30101, name: 'Ethereum', short: 'ETH', color: 0x8a92b2, testnet: false },
  { chainId: 56, eid: 30102, name: 'BNB Chain', short: 'BNB', color: 0xf0b90b, testnet: false, native: 'BNB' },
  { chainId: 10, eid: 30111, name: 'Optimism', short: 'OP', color: 0xff0420, testnet: false },
  { chainId: 137, eid: 30109, name: 'Polygon', short: 'POL', color: 0x8247e5, testnet: false, native: 'POL' },
  { chainId: 8453, eid: 30184, name: 'Base', short: 'BASE', color: 0x0052ff, testnet: false },
  { chainId: 42161, eid: 30110, name: 'Arbitrum', short: 'ARB', color: 0x28a0f0, testnet: false },
  { chainId: 43114, eid: 30106, name: 'Avalanche', short: 'AVAX', color: 0xe84142, testnet: false, native: 'AVAX' },

  { chainId: 11155111, eid: 40161, name: 'Sepolia', short: 'SEP', color: 0x8a92b2, testnet: true },
  { chainId: 84532, eid: 40245, name: 'Base Sepolia', short: 'BASE', color: 0x0052ff, testnet: true },
  { chainId: 421614, eid: 40231, name: 'Arbitrum Sepolia', short: 'ARB', color: 0x28a0f0, testnet: true },
  { chainId: 11155420, eid: 40232, name: 'OP Sepolia', short: 'OP', color: 0xff0420, testnet: true },
  { chainId: 80002, eid: 40267, name: 'Polygon Amoy', short: 'POL', color: 0x8247e5, testnet: true, native: 'POL' },

  // `npm run dev:fork`: a mainnet fork as the hub and a plain anvil as a
  // spoke, joined by mock LayerZero endpoints. No real endpoint ids exist for
  // these, so none are listed; the messengers are told theirs explicitly.
  { chainId: 31337, name: 'Local hub', short: 'HUB', color: 0x8a92b2, testnet: true },
  { chainId: 31338, name: 'Local spoke', short: 'SPOKE', color: 0x2fbf71, testnet: true },
];

const byChainId = new Map<number, ChainInfo>(CHAINS.map((chain) => [chain.chainId, chain]));
const byEid = new Map<number, ChainInfo>(
  CHAINS.flatMap((chain) => (chain.eid === undefined ? [] : [[chain.eid, chain] as const])),
);

/** Always returns something renderable, so an unknown spoke degrades to its id. */
export function chainInfo(chainId: number): ChainInfo {
  return (
    byChainId.get(chainId) ?? {
      chainId,
      name: `Chain ${chainId}`,
      short: String(chainId),
      color: UNKNOWN_COLOR,
      testnet: false,
    }
  );
}

export function chainIdForEid(eid: number): number | null {
  return byEid.get(eid)?.chainId ?? null;
}

export function eidForChainId(chainId: number): number | null {
  return byChainId.get(chainId)?.eid ?? null;
}

/** The chain a `GameEscrow.seatOrigin` value names: zero means the stake was placed on the hub. */
export function originChainId(origin: number, hubChainId: number): number {
  return origin === 0 ? hubChainId : origin;
}

/** `#rrggbb`, for the DOM side of the badge. */
export function chainCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
