/**
 * Chain identity, shared by the server and the client: the chains the hub and
 * its spokes run on, by EVM chain id. `GameEscrow.seatOrigin` holds the chain
 * a bridged stake came from, or zero for a stake placed on the hub;
 * `originChainId` turns that into the chain a `Seat` shows.
 */

/** Seat origin used by practice matches, which never touch a chain. */
export const PRACTICE_CHAIN_ID = 0;

export interface ChainInfo {
  chainId: number;
  name: string;
  /** Short label for the arena badge, where there is room for about five characters. */
  short: string;
  /**
   * Badge colour as `0xRRGGBB`. Pixi wants the number and CSS wants the hex
   * string, so it is stored in the form both can be derived from.
   */
  color: number;
  testnet: boolean;
}

const UNKNOWN_COLOR = 0x6b7689;

/**
 * Chains the client knows how to label: the hub (Base) and the spokes Across
 * bridges ETH from, which all use ETH for gas, so a stake is ETH everywhere.
 * An unlisted chain still renders — it falls back to its numeric id — so a new
 * spoke works before this table does.
 */
export const CHAINS: readonly ChainInfo[] = [
  { chainId: PRACTICE_CHAIN_ID, name: 'Practice', short: 'PRAC', color: 0x6b7689, testnet: false },

  { chainId: 1, name: 'Ethereum', short: 'ETH', color: 0x8a92b2, testnet: false },
  { chainId: 10, name: 'Optimism', short: 'OP', color: 0xff0420, testnet: false },
  { chainId: 8453, name: 'Base', short: 'BASE', color: 0x0052ff, testnet: false },
  { chainId: 42161, name: 'Arbitrum', short: 'ARB', color: 0x28a0f0, testnet: false },

  { chainId: 11155111, name: 'Sepolia', short: 'SEP', color: 0x8a92b2, testnet: true },
  { chainId: 84532, name: 'Base Sepolia', short: 'BASE', color: 0x0052ff, testnet: true },
  { chainId: 421614, name: 'Arbitrum Sepolia', short: 'ARB', color: 0x28a0f0, testnet: true },
  { chainId: 11155420, name: 'OP Sepolia', short: 'OP', color: 0xff0420, testnet: true },

  // `npm run dev:fork`: a mainnet fork as the hub and a plain anvil as a
  // spoke, joined by mock Across SpokePools that the script fills.
  { chainId: 31337, name: 'Local hub', short: 'HUB', color: 0x8a92b2, testnet: true },
  { chainId: 31338, name: 'Local spoke', short: 'SPOKE', color: 0x2fbf71, testnet: true },
];

const byChainId = new Map<number, ChainInfo>(CHAINS.map((chain) => [chain.chainId, chain]));

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

/** The chain a `GameEscrow.seatOrigin` value names: zero means the stake was placed on the hub. */
export function originChainId(origin: number, hubChainId: number): number {
  return origin === 0 ? hubChainId : origin;
}

/** `#rrggbb`, for the DOM side of the badge. */
export function chainCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
