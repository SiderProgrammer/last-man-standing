/**
 * Address comparison.
 *
 * EVM addresses are case-insensitive, but the mixed-case EIP-55 checksum form
 * is what wallets hand out and what the chain emits in logs. Anything that
 * keys a map or compares two addresses therefore has to pick a canonical form
 * first, and the whole codebase picks lowercase.
 *
 * These exist so that choice is made in one place rather than at every call
 * site. They are deliberately not applied anywhere a normalising call did not
 * already exist — see `docs/FIX_PLAN.md` step 7.2 for the one place that looks
 * like it wants `addressKey` and does not get it.
 */

/** The zero address, used as "unset" for every configured address. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Canonical map key for an address. */
export function addressKey(value: string): string {
  return value.toLowerCase();
}

/** True when two addresses are the same account, whatever their casing. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
