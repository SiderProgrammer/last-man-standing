import { keccak256, toHex, type Hex } from 'viem';

/**
 * Seeded uniform PRNG in [0, 1). Small and fast; the load and chaos runs need
 * reproducibility, not cryptographic quality.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A distinct, deterministic test key per bot index. Never a real key: derived
 * from a public label, so anyone can recompute it.
 */
export function keyFor(index: number, label = 'lms-harness'): Hex {
  return keccak256(toHex(`${label}:${index}`));
}
