import { createAvatar } from '@dicebear/core';
import { bottts } from '@dicebear/collection';

/**
 * The face a seat wears until, or unless, it has an NFT avatar: a DiceBear
 * "Bottts" robot seeded by the wallet address, so a wallet looks the same in
 * every match. Generated in the browser as an SVG data URI; nothing is fetched.
 *
 * Bottts is by Pablo Stanley, free for personal and commercial use
 * (https://bottts.com/); DiceBear itself is MIT.
 */
export function defaultAvatar(address: string): string {
  return createAvatar(bottts, { seed: address.toLowerCase(), size: 128 }).toDataUri();
}
