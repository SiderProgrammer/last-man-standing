import { existsSync, readFileSync } from 'node:fs';
import * as z from 'zod/v4';

/**
 * The deployment registry: `contracts/deployments/<chainId>.json`, as
 * `Deploy.s.sol` writes it, with every address and the block the deploy
 * started at.
 *
 * Node-only, so it is the package's `./registry` entry rather than part of
 * its index, which the browser bundles. The server is its one reader; the
 * client learns addresses from the server's `hello`.
 */
export interface Deployment {
  chainId: number;
  /** No contract in `contracts` is older: where log scans start. */
  deployBlock: number;
  contracts: Record<string, `0x${string}`>;
}

/** A registry file that is there but cannot be used. */
export class DeploymentError extends Error {
  override name = 'DeploymentError';
}

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((value) => value as `0x${string}`);

const DEPLOYMENT = z.object({
  chainId: z.number().int(),
  deployBlock: z.number().int().min(0),
  contracts: z.record(z.string(), hexAddress),
});

const DEPLOYMENTS_DIR = new URL('../../../contracts/deployments/', import.meta.url);

/**
 * The registry the deploy script wrote for `chainId`, or null if there is
 * none. Throws on a file that is there but malformed, or names another chain.
 */
export function readDeployment(chainId: number, dir: URL = DEPLOYMENTS_DIR): Deployment | null {
  const file = new URL(`${chainId}.json`, dir);
  if (!existsSync(file)) return null;
  const result = DEPLOYMENT.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!result.success) throw new DeploymentError(`invalid deployment registry ${file.pathname}: ${result.error.message}`);
  if (result.data.chainId !== chainId) {
    throw new DeploymentError(`deployment registry ${file.pathname} is for chain ${result.data.chainId}, not ${chainId}`);
  }
  return result.data;
}
