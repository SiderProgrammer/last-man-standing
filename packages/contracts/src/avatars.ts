import { playerAvatarsAbi } from './abis.js';

/**
 * The `PlayerAvatars` surface, shared by the server and the browser client.
 *
 * The collection is deployed once per chain rather than bridged, so a player
 * mints where they already play. Which deployment applies to a seat is decided
 * by the chain that seat staked from.
 */
export { playerAvatarsAbi };
