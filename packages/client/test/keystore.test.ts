import { describe, expect, it } from 'vitest';
import { KeyStore, memoryRecords, type Records } from '../src/io/keystore.js';

const SECRET = JSON.stringify({ privateKey: `0x${'5e'.repeat(32)}` });

/** Records that also expose what was written, as a dump of the store would. */
function inspectable(): Records & { values: () => unknown[] } {
  const map = new Map<string, unknown>();
  return {
    get: async (name) => map.get(name),
    put: async (name, value) => void map.set(name, value),
    delete: async (name) => void map.delete(name),
    values: () => [...map.values()],
  };
}

describe('KeyStore', () => {
  it('reads back what it wrote, and forgets what it removed', async () => {
    const store = new KeyStore(memoryRecords());
    await store.write('grant', SECRET);
    expect(await store.read('grant')).toBe(SECRET);
    await store.remove('grant');
    expect(await store.read('grant')).toBeNull();
    expect(await store.read('never written')).toBeNull();
  });

  /** A copy of the browser's storage must not be a copy of the key. */
  it('stores only ciphertext, sealed by a key that cannot be exported', async () => {
    const records = inspectable();
    const store = new KeyStore(records);
    await store.write('grant', SECRET);

    const stored = records.values();
    const text = JSON.stringify(stored, (_, value) =>
      value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? Buffer.from(value as ArrayBuffer).toString('hex') : value,
    );
    expect(text).not.toContain('5e5e5e5e');

    const wrapping = stored.find((value): value is CryptoKey => value instanceof CryptoKey);
    expect(wrapping?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', wrapping as CryptoKey)).rejects.toThrow();
  });

  it('keeps one sealing key across instances over the same records', async () => {
    const records = memoryRecords();
    await new KeyStore(records).write('grant', SECRET);
    expect(await new KeyStore(records).read('grant')).toBe(SECRET);
  });

  /** Sealed under a key since lost (site data cleared halfway): no secret, no throw. */
  it('reads a record it cannot unseal as nothing', async () => {
    const records = memoryRecords();
    await new KeyStore(records).write('grant', SECRET);
    await records.delete('wrapping-key');
    expect(await new KeyStore(records).read('grant')).toBeNull();
  });

  it('survives storage that refuses every call', async () => {
    const broken: Records = {
      get: () => Promise.reject(new Error('blocked')),
      put: () => Promise.reject(new Error('blocked')),
      delete: () => Promise.reject(new Error('blocked')),
    };
    const store = new KeyStore(broken);
    await expect(store.write('grant', SECRET)).resolves.toBeUndefined();
    await expect(store.read('grant')).resolves.toBeNull();
    await expect(store.remove('grant')).resolves.toBeUndefined();
  });
});
