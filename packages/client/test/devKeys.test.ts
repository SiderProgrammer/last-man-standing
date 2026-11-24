import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesWithDevKeys } from '../src/devKeys.js';

const A = `0x${'aB'.repeat(32)}`;
const B = `0x${'12'.repeat(32)}`;

describe('dev keys in a build', () => {
  it('names the files that hold one, whatever its spelling', () => {
    const files = [
      { name: 'clean.js', text: 'const x = 1;' },
      { name: 'one.js', text: `key:"${A}"` },
      { name: 'bare.js', text: `key:"${A.slice(2).toLowerCase()}"` },
      { name: 'list.js', text: `keys:"${B}"` },
    ];
    expect(filesWithDevKeys({ VITE_DEV_KEY: A, VITE_DEV_KEYS: `${A}, ${B}` }, files)).toEqual(['one.js', 'bare.js', 'list.js']);
  });

  it('finds nothing when no key is set', () => {
    const files = [{ name: 'a.js', text: A }];
    expect(filesWithDevKeys({}, files)).toEqual([]);
    expect(filesWithDevKeys({ VITE_DEV_KEY: '', VITE_DEV_KEYS: ' , ' }, files)).toEqual([]);
  });

  it('are never inlined by reading import.meta.env whole', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const whole = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
      .filter((file) => {
        const code = readFileSync(`${src}/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '');
        return /import\.meta\.env(?!\.[A-Za-z_])/.test(code);
      });
    expect(whole).toEqual([]);
  });
});
