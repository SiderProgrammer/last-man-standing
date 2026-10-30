/**
 * Secrets this browser keeps, sealed with a key the page can use but never read.
 *
 * The session key is secp256k1, which WebCrypto cannot hold, so the key itself
 * has to exist as bytes for viem to sign with. What can be non-extractable is
 * the AES-GCM key that seals it at rest: generated with `extractable: false`
 * and kept in IndexedDB as a `CryptoKey`, which the browser stores without
 * ever exposing its bytes to script. So a copy of the site's storage — a
 * leaked profile, an extension reading localStorage, a script that dumps
 * IndexedDB and leaves — holds only ciphertext. Script running in the page
 * can still ask WebCrypto to unseal, which is why the page's CSP admits no
 * script but its own, and why what the key can do is capped on-chain.
 *
 * Where IndexedDB or WebCrypto is missing, secrets live in memory for the
 * page's lifetime and are never written anywhere in the clear.
 */

/** Where sealed records live. IndexedDB in the browser; a `Map` in tests. */
export interface Records {
  get(name: string): Promise<unknown>;
  put(name: string, value: unknown): Promise<void>;
  delete(name: string): Promise<void>;
}

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

const WRAPPING_KEY = 'wrapping-key';

export class KeyStore {
  private wrapping: Promise<CryptoKey> | null = null;

  constructor(
    private readonly records: Records,
    private readonly subtle: SubtleCrypto = crypto.subtle,
  ) {}

  /** The browser's store, or one in memory where IndexedDB is unavailable. */
  static open(): KeyStore {
    return new KeyStore(typeof indexedDB !== 'undefined' && crypto?.subtle ? indexedDbRecords() : memoryRecords());
  }

  async read(name: string): Promise<string | null> {
    try {
      const sealed = (await this.records.get(name)) as Sealed | undefined;
      if (!sealed) return null;
      const plain = await this.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await this.key(), sealed.data);
      return new TextDecoder().decode(plain);
    } catch {
      // Blocked storage, a record sealed under a key since lost: no secret.
      return null;
    }
  }

  async write(name: string, secret: string): Promise<void> {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await this.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), new TextEncoder().encode(secret));
      await this.records.put(name, { iv, data } satisfies Sealed);
    } catch {
      // The caller loses durability, not correctness: the secret still works
      // for this page's lifetime.
    }
  }

  async remove(name: string): Promise<void> {
    await this.records.delete(name).catch(() => undefined);
  }

  /** The sealing key: made once per browser profile, never extractable. */
  private key(): Promise<CryptoKey> {
    this.wrapping ??= (async () => {
      const stored = (await this.records.get(WRAPPING_KEY)) as CryptoKey | undefined;
      if (stored) return stored;
      const key = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await this.records.put(WRAPPING_KEY, key);
      return key;
    })();
    this.wrapping.catch(() => {
      this.wrapping = null;
    });
    return this.wrapping;
  }
}

export function memoryRecords(): Records {
  const map = new Map<string, unknown>();
  return {
    get: async (name) => map.get(name),
    put: async (name, value) => void map.set(name, value),
    delete: async (name) => void map.delete(name),
  };
}

const DB = 'lms';
const STORE = 'keys';

function indexedDbRecords(): Records {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        db = null;
        reject(request.error);
      };
    }));
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await open()).transaction(STORE, mode).objectStore(STORE);
    return new Promise<T>((resolve, reject) => {
      const request = act(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    get: (name) => run('readonly', (store) => store.get(name)),
    put: async (name, value) => void (await run('readwrite', (store) => store.put(value, name))),
    delete: async (name) => void (await run('readwrite', (store) => store.delete(name))),
  };
}
