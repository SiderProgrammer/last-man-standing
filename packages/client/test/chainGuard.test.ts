import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { viemChain, WrongChainError } from '../src/wallet/chains.js';
import { Wallet } from '../src/wallet/wallet.js';

const ESCROW = '0x00000000000000000000000000000000000000e5';
const ACCOUNT = '0x00000000000000000000000000000000000000a1';
const MATCH = `0x${'11'.repeat(32)}` as const;

/**
 * An injected wallet that knows `known` chains and starts on `chainId`.
 * Records what it was asked, and reports switches the way a provider does.
 */
function fakeProvider(chainId: number, known: number[], options: { decline?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Set<(hex: string) => void>();
  let current = chainId;
  const provider = {
    calls,
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      calls.push(method);
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [ACCOUNT];
        case 'eth_chainId':
          return `0x${current.toString(16)}`;
        case 'wallet_switchEthereumChain': {
          if (options.decline) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          const wanted = Number((params?.[0] as { chainId: string }).chainId);
          if (!known.includes(wanted)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
          current = wanted;
          for (const listener of listeners) listener(`0x${wanted.toString(16)}`);
          return null;
        }
        case 'wallet_addEthereumChain':
          known.push(Number((params?.[0] as { chainId: string }).chainId));
          return null;
        default:
          // Anything that would sign or read state: the guard must stop
          // before it, so reaching here is the failure under test.
          throw new Error(`unexpected ${method}`);
      }
    },
    on(event: string, handler: (hex: string) => void) {
      if (event === 'chainChanged') listeners.add(handler);
    },
    removeListener(event: string, handler: (hex: string) => void) {
      if (event === 'chainChanged') listeners.delete(handler);
    },
  };
  return provider;
}

function install(provider: unknown): void {
  (globalThis as { window?: unknown }).window = { ethereum: provider };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('chain guard', () => {
  it('switches an injected wallet to the hub before a join', async () => {
    const provider = fakeProvider(42161, [42161, 8453]);
    install(provider);
    const seen: number[] = [];
    const wallet = await Wallet.connect((chainId) => seen.push(chainId));
    wallet.hubChainId = 8453;

    await expect(wallet.ensureChain(8453)).resolves.toBeUndefined();
    expect(wallet.chainId).toBe(8453);
    expect(seen).toEqual([8453]);
    expect(provider.calls).toContain('wallet_switchEthereumChain');
  });

  it('adds a chain the wallet has never seen, then switches to it', async () => {
    const provider = fakeProvider(1, [1]);
    install(provider);
    const wallet = await Wallet.connect();

    await wallet.ensureChain(84532);
    expect(wallet.chainId).toBe(84532);
    expect(provider.calls.filter((method) => method === 'wallet_switchEthereumChain')).toHaveLength(2);
    expect(provider.calls).toContain('wallet_addEthereumChain');
  });

  it('refuses a join when the player declines the switch, before simulating anything', async () => {
    const provider = fakeProvider(42161, [42161, 8453], { decline: true });
    install(provider);
    const wallet = await Wallet.connect();
    wallet.hubChainId = 8453;

    await expect(wallet.join(ESCROW, MATCH, 10n ** 15n)).rejects.toBeInstanceOf(WrongChainError);
    expect(provider.calls).not.toContain('eth_call');
    expect(wallet.chainId).toBe(42161);
  });

  it('refuses a wallet that signs in-process, which cannot switch', async () => {
    // Port 9 answers nothing: the burner falls back to chain 0, practice only.
    const wallet = await Wallet.fromAccount(privateKeyToAccount(generatePrivateKey()), 'http://127.0.0.1:9');
    wallet.hubChainId = 8453;

    const error = await wallet.createMatch(ESCROW, '0.001', 4).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WrongChainError);
    expect((error as Error).message).toContain('Base');
  });

  it('follows a switch made in the wallet itself', async () => {
    const provider = fakeProvider(8453, [8453, 10]);
    install(provider);
    const seen: number[] = [];
    const wallet = await Wallet.connect((chainId) => seen.push(chainId));

    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa' }] });
    expect(wallet.chainId).toBe(10);
    expect(seen).toEqual([10]);
  });

  it('names chains as the rest of the client does, with an RPC to add them by', () => {
    const base = viemChain(8453);
    expect(base.name).toBe('Base');
    expect(base.rpcUrls.default.http[0]).toMatch(/^https:/);
    expect(viemChain(999_999).rpcUrls.default.http).toEqual([]);
  });
});
