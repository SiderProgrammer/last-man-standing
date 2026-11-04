import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FX_BUNDLE, FX_NAMES, manifest } from '../src/assets/manifest.js';

const source = (file: string): string => readFileSync(new URL(`../src/arena/${file}`, import.meta.url), 'utf8');

/** The first capture of every match of `pattern` in `text`. */
const captures = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((match) => match[1] as string);

/**
 * Every texture the arena asks for by name. Names are plain strings, so a
 * misspelt one compiles and quietly draws the fallback glow: this is what
 * catches it. A new way of naming a texture needs a pattern here.
 */
function namedInCode(): string[] {
  const effects = source('effects.ts');
  return [
    ...captures(source('recipes.ts'), /texture: '([\w-]+)'/g),
    ...captures(effects, /acquire\('([\w-]+)'/g),
    // `[texture, a, b]`, the tuples effects.ts builds a sprite from.
    ...captures(effects, /\['([\w-]+)', [^,\]]+, [^,\]]+\]/g),
    ...captures(source('arena.ts'), /textures\.(\w+)/g),
  ];
}

describe('fx manifest', () => {
  it('loads each image in the folder under its file name', () => {
    const bundle = manifest.bundles.find((candidate) => candidate.name === FX_BUNDLE);
    const assets = bundle?.assets as Array<{ alias: string; src: string }>;
    expect(assets.length).toBeGreaterThan(0);
    for (const { alias, src } of assets) {
      expect(alias).toMatch(/^[\w-]+$/);
      expect(src).toContain(alias);
    }
  });

  it('has a file for every texture the code asks for by name', () => {
    const names = namedInCode();
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !FX_NAMES.includes(name))).toEqual([]);
  });
});
