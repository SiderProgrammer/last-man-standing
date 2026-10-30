/**
 * Where Foundry put a contract's artifact in `contracts/out`.
 *
 * GameEscrow compiles under its own optimizer profile (see foundry.toml), so a
 * file compiled under both profiles gets one artifact per profile —
 * `Name.default.json` and `Name.escrow.json` — and a file compiled under one
 * gets a plain `Name.json`. Which of these exists depends on what the last
 * build compiled. The ABI is the same in all of them.
 */
import { existsSync, readdirSync } from 'node:fs';

export function artifactPath(outDir, contract) {
  const dir = `${outDir}${contract}.sol/`;
  for (const name of [`${contract}.json`, `${contract}.default.json`]) {
    if (existsSync(dir + name)) return dir + name;
  }
  const other = existsSync(dir)
    ? readdirSync(dir).find((file) => file.startsWith(`${contract}.`) && file.endsWith('.json'))
    : undefined;
  if (!other) throw new Error(`No artifact for ${contract} in ${dir}: run forge build.`);
  return dir + other;
}
