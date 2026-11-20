import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import type { ServerMessage } from '@lms/api';
import { Faucet, type FaucetPort } from '@lms/server';

const PLAYER = `0x${'a1'.repeat(20)}` as const;
const OTHER = `0x${'b2'.repeat(20)}` as const;
const LIQUID = 10_000n * 10n ** 18n;
const STAKED = 40_000n * 10n ** 18n;

class FakePort implements FaucetPort {
  readonly paid = new Set<string>();
  readonly sent: Address[] = [];
  eth = new Map<string, bigint>();
  left = 200n;
  revert: string | null = null;
  /** Holds every drip until released, to race two sign-ins. */
  gate: Promise<void> | null = null;

  async dripped(account: Address): Promise<boolean> {
    return this.paid.has(account.toLowerCase());
  }
  async scoopsLeft(): Promise<bigint> {
    return this.left;
  }
  async ethOf(account: Address): Promise<bigint> {
    return this.eth.get(account.toLowerCase()) ?? 0n;
  }
  async scoop(): Promise<{ liquid: bigint; staked: bigint }> {
    return { liquid: LIQUID, staked: STAKED };
  }
  async drip(account: Address): Promise<Hex> {
    if (this.gate) await this.gate;
    if (this.revert) throw new Error(`execution reverted: ${this.revert}`);
    this.paid.add(account.toLowerCase());
    this.sent.push(account);
    this.left -= 1n;
    return `0x${String(this.sent.length).padStart(64, '0')}`;
  }
}

function setup() {
  const port = new FakePort();
  const told: Array<{ address: Address; message: ServerMessage }> = [];
  const faucet = new Faucet({ port, notify: (address, message) => told.push({ address, message }) });
  port.eth.set(PLAYER.toLowerCase(), 1n);
  return { port, faucet, told };
}

describe('Faucet', () => {
  it('drips a wallet with ETH once, and tells it what it got', async () => {
    const { port, faucet, told } = setup();
    expect(await faucet.maybeDrip(PLAYER)).toBe('dripped');
    expect(port.sent).toEqual([PLAYER]);
    expect(told).toEqual([
      {
        address: PLAYER,
        message: { type: 'dripped', liquid: LIQUID.toString(), staked: STAKED.toString(), tx: `0x${'1'.padStart(64, '0')}` },
      },
    ]);

    expect(await faucet.maybeDrip(PLAYER)).toBe('already');
    expect(port.sent).toHaveLength(1);
  });

  it('skips a wallet the faucet paid before this process started, after one read', async () => {
    const { port, faucet } = setup();
    port.paid.add(PLAYER.toLowerCase());
    const read = vi.spyOn(port, 'dripped');
    expect(await faucet.maybeDrip(PLAYER)).toBe('already');
    expect(await faucet.maybeDrip(PLAYER)).toBe('already');
    expect(read).toHaveBeenCalledTimes(1);
    expect(port.sent).toHaveLength(0);
  });

  it('leaves a wallet with no ETH, such as a guest, until it signs in with some', async () => {
    const { port, faucet } = setup();
    expect(await faucet.maybeDrip(OTHER)).toBe('no-eth');
    expect(port.sent).toHaveLength(0);

    port.eth.set(OTHER.toLowerCase(), 10n ** 15n);
    expect(await faucet.maybeDrip(OTHER)).toBe('dripped');
  });

  it('sends one drip when two sockets of a wallet sign in at once', async () => {
    const { port, faucet } = setup();
    let release!: () => void;
    port.gate = new Promise((resolve) => (release = resolve));
    const first = faucet.maybeDrip(PLAYER);
    const second = await faucet.maybeDrip(PLAYER);
    release();
    expect(second).toBe('busy');
    expect(await first).toBe('dripped');
    expect(port.sent).toHaveLength(1);
  });

  it('stops trying once the jar is empty', async () => {
    const { port, faucet } = setup();
    port.left = 0n;
    expect(await faucet.maybeDrip(PLAYER)).toBe('empty');
    const read = vi.spyOn(port, 'dripped');
    expect(await faucet.maybeDrip(OTHER)).toBe('empty');
    expect(read).not.toHaveBeenCalled();
  });

  it('logs a failed drip, never throws, and tries again on the next sign-in', async () => {
    const { port, faucet, told } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    port.revert = 'AlreadyDripped';
    expect(await faucet.maybeDrip(PLAYER)).toBe('failed');
    expect(told).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    port.revert = null;
    expect(await faucet.maybeDrip(PLAYER)).toBe('dripped');
  });

  it('onLogin returns at once and drips in the background', async () => {
    const { port, faucet } = setup();
    faucet.onLogin(PLAYER);
    await vi.waitFor(() => expect(port.sent).toEqual([PLAYER]));
  });
});
