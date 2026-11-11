/**
 * Accounts on a local fork: anvil's public test mnemonic, started with
 * `--accounts 20`, so anvil funds every one and signs for it. Worthless
 * anywhere else, and public, so never send anything of value to them.
 *
 * Shared by `scripts/fork-base.mjs`, which starts the fork, and
 * `scripts/play.mjs`, which plays on it.
 */
import { toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

export const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

/** How many accounts anvil is started with. Players take the last eight. */
export const FORK_ACCOUNT_COUNT = 20;

/** The first player's index in the mnemonic: 10, 11, … 17. */
export const FIRST_PLAYER_INDEX = 10;
export const MAX_PLAYERS = 8;

/**
 * Every role the production deploy names, one account each, so the fork
 * checks the same separation of roles `Deploy.s.sol` and the server enforce.
 */
export const ROLE_INDEX = {
  deployer: 0,
  attestor: 1,
  keeper: 2,
  matchmaker: 3,
  sessionRelayer: 4,
  /** Stands in for the Safe: an EOA, since the fork has no Safe of ours. */
  safe: 5,
  guardian: 6,
  team: 7,
  /** Plays the Across relayer on both chains. */
  acrossRelayer: 8,
  /** Somebody with no role at all, for permissionless calls. */
  outsider: 9,
};

/** `{ index, address, key }` for one mnemonic index. */
export function forkAccount(index) {
  const account = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index });
  return { index, address: account.address, key: toHex(account.getHdKey().privateKey) };
}

export function forkRoles() {
  return Object.fromEntries(Object.entries(ROLE_INDEX).map(([role, index]) => [role, forkAccount(index)]));
}

export function forkPlayers(count = MAX_PLAYERS) {
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, ...forkAccount(FIRST_PLAYER_INDEX + i) }));
}
