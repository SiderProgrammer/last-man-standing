export const config = {
  port: Number(process.env.WS_PORT ?? 8787),
  chainId: Number(process.env.CHAIN_ID ?? 11155111),
  commitMs: Number(process.env.COMMIT_MS ?? 20_000),
  revealMs: Number(process.env.REVEAL_MS ?? 12_000),
  startingChips: Number(process.env.STARTING_CHIPS ?? 1_000),
  rpcUrl: process.env.RPC_URL ?? '',
  escrow: (process.env.ESCROW_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
  attestorPk: process.env.ATTESTOR_PK as `0x${string}` | undefined,
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
};
