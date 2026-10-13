/**
 * Chain identity, shared by the server and the client.
 *
 * Two id spaces meet in this file and they are not the same thing. An EVM chain
 * id (`1`, `8453`, `11155111`) is what a wallet reports and what a block
 * explorer keys on. A transport endpoint id — LayerZero v2's `eid` — is what
 * `ICrossChainMessenger` carries and therefore what `GameEscrow.seatOrigin`
 * stores. Conflating them shows a player "chain 40161" when they staked on
 * Sepolia, so every origin coming off the escrow goes through
 * `normaliseOriginChainId` before it reaches a `Seat`.
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
}

const UNKNOWN_COLOR = 0x6b7689;

/**
 * Chains the client knows how to label. An unlisted chain still renders — it
 * falls back to its numeric id — so a new spoke works before this table does.
 */
export const CHAINS: readonly ChainInfo[] = [
  { chainId: PRACTICE_CHAIN_ID, name: 'Practice', short: 'PRAC', color: 0x6b7689, testnet: false },

  { chainId: 1, eid: 30101, name: 'Ethereum', short: 'ETH', color: 0x8a92b2, testnet: false },
  { chainId: 56, eid: 30102, name: 'BNB Chain', short: 'BNB', color: 0xf0b90b, testnet: false },
  { chainId: 10, eid: 30111, name: 'Optimism', short: 'OP', color: 0xff0420, testnet: false },
  { chainId: 137, eid: 30109, name: 'Polygon', short: 'POL', color: 0x8247e5, testnet: false },
  { chainId: 8453, eid: 30184, name: 'Base', short: 'BASE', color: 0x0052ff, testnet: false },
  { chainId: 42161, eid: 30110, name: 'Arbitrum', short: 'ARB', color: 0x28a0f0, testnet: false },
  { chainId: 43114, eid: 30106, name: 'Avalanche', short: 'AVAX', color: 0xe84142, testnet: false },

  { chainId: 11155111, eid: 40161, name: 'Sepolia', short: 'SEP', color: 0x8a92b2, testnet: true },
  { chainId: 84532, eid: 40245, name: 'Base Sepolia', short: 'BASE', color: 0x0052ff, testnet: true },
  { chainId: 421614, eid: 40231, name: 'Arbitrum Sepolia', short: 'ARB', color: 0x28a0f0, testnet: true },
  { chainId: 11155420, eid: 40232, name: 'OP Sepolia', short: 'OP', color: 0xff0420, testnet: true },
  { chainId: 80002, eid: 40267, name: 'Polygon Amoy', short: 'POL', color: 0x8247e5, testnet: true },
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

/**
 * Turns a `GameEscrow.seatOrigin` value into an EVM chain id.
 *
 * The escrow stores whatever `srcChainId` the messenger delivered, and zero
 * for a player who staked on the hub directly. `LayerZeroMessenger` now
 * translates endpoint ids to chain ids before the escrow sees them, so the
 * value is normally already a chain id and passes straight through; mapping a
 * known endpoint id is kept for escrows fed by an older adapter. An id that
 * matches no known endpoint renders as a number rather than as the wrong chain.
 */
export function normaliseOriginChainId(origin: number, hubChainId: number): number {
  if (origin === 0) return hubChainId;
  return chainIdForEid(origin) ?? origin;
}

/** `#rrggbb`, for the DOM side of the badge. */
export function chainCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
