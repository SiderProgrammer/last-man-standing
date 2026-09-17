const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const config = {
  port: Number(process.env.WS_PORT ?? 8787),
  chainId: Number(process.env.CHAIN_ID ?? 11155111),
  commitMs: Number(process.env.COMMIT_MS ?? 20_000),
  revealMs: Number(process.env.REVEAL_MS ?? 12_000),
  startingChips: Number(process.env.STARTING_CHIPS ?? 1_000),
  rpcUrl: process.env.RPC_URL ?? '',
  escrow: (process.env.ESCROW_ADDRESS ?? ZERO_ADDRESS) as `0x${string}`,
  attestorPk: process.env.ATTESTOR_PK as `0x${string}` | undefined,
  /** Optional key that pays for the permissionless `lockMatch` call. */
  keeperPk: (process.env.KEEPER_PK ?? process.env.ATTESTOR_PK) as `0x${string}` | undefined,
  databaseUrl: process.env.DATABASE_URL ?? '',
  /**
   * `PlayerAvatars` deployments, as JSON:
   * `[{"chainId":11155111,"address":"0x…","rpcUrl":"https://…"}]`
   *
   * One entry per chain players mint on, because the collection is deployed
   * per chain rather than bridged. Reading a spoke's collection needs that
   * spoke's RPC, which is why the URL travels with the address.
   */
  avatarCollections: process.env.AVATAR_COLLECTIONS ?? '',
  /** Prefix `ipfs://` is rewritten to when fetching avatar metadata. */
  ipfsGateway: process.env.IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/',
  /**
   * `SessionKeyDelegate` on the hub chain. Players delegate their EOA to it
   * under EIP-7702 so the client can sign logins with a scoped session key
   * instead of prompting the wallet on every reconnect. Blank disables the
   * offer; logins then always cost a wallet signature.
   */
  sessionDelegate: (process.env.SESSION_DELEGATE ?? ZERO_ADDRESS) as `0x${string}`,
  /** True once an escrow is configured and the chain bridge can run. */
  get onChain(): boolean {
    return Boolean(this.rpcUrl) && this.escrow !== ZERO_ADDRESS;
  },
};

export { ZERO_ADDRESS };
