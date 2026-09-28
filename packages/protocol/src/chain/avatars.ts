import { parseAbi } from 'viem';

/**
 * The `PlayerAvatars` surface, shared by the server and the browser client.
 *
 * The collection is deployed once per chain rather than bridged, so a player
 * mints where they already play. Which deployment applies to a seat is decided
 * by the chain that seat staked from.
 */
export const playerAvatarsAbi = parseAbi([
  'function avatarOf(address player) view returns (uint256 tokenId, string uri)',
  'function equipped(address owner) view returns (uint256)',
  'function hasMinted(address minter) view returns (bool)',
  'function totalMinted() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function mint() returns (uint256)',
  'function equip(uint256 tokenId)',
  'function unequip()',
  'event Minted(address indexed to, uint256 indexed tokenId)',
  'event Equipped(address indexed owner, uint256 indexed tokenId)',
]);

/**
 * The avatar a seat is wearing.
 *
 * This travels beside `PublicMatchState` rather than inside it: an avatar is
 * cosmetic, and the engine that produces the match snapshot must not know it
 * exists. Nothing here reaches the commit hash, the round hashes or the
 * history root, so a replay is identical with or without avatars.
 */
export interface AvatarEntry {
  seat: number;
  /** Token id as a decimal string, because it is a `uint256`. */
  tokenId: string;
  /** Chain the collection lives on — the same chain the seat staked from. */
  chainId: number;
  /**
   * Resolved image URL, already rewritten from `ipfs://` to a gateway.
   * Null when the metadata could not be read: the seat then falls back to its
   * plain circle and the match is unaffected.
   */
  image: string | null;
}
