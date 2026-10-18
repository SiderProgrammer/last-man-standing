import { describe, expect, it } from 'vitest';
import { BotClient, keyFor, type BotEvent } from '@lms/harness';
import { privateKeyToAccount } from 'viem/accounts';
import { simSigner, world } from './sim.js';

describe('bot client', () => {
  it('logs in, plays practice games to the end, and stops', async () => {
    const { clock, net, random } = world();
    const events: BotEvent[] = [];
    const bot = new BotClient({
      privateKey: keyFor(0),
      sign: simSigner(privateKeyToAccount(keyFor(0)).address),
      connect: () => net.connect(),
      games: 2,
      thinkMs: () => 200,
      schedule: clock.schedule,
      now: () => clock.now,
      random,
      onEvent: (event) => events.push(event),
    });
    bot.start();
    for (let i = 0; i < 600 && !bot.done; i += 1) await clock.advance(1_000);

    expect(bot.played).toBe(2);
    expect(events.filter((event) => event.type === 'authed').length).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.type === 'revealed')).toBe(true);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
  });

  it('reconnects after a drop and still reveals the move it committed', async () => {
    const { clock, net, random } = world(2);
    const events: BotEvent[] = [];
    const bot = new BotClient({
      privateKey: keyFor(1),
      sign: simSigner(privateKeyToAccount(keyFor(1)).address),
      connect: () => net.connect(),
      thinkMs: () => 100,
      schedule: clock.schedule,
      now: () => clock.now,
      random,
      onEvent: (event) => events.push(event),
    });
    bot.start();

    // Advance until the bot has committed, then cut the connection.
    for (let i = 0; i < 100 && !events.some((event) => event.type === 'committed'); i += 1) await clock.advance(100);
    const committed = events.find((event) => event.type === 'committed');
    expect(committed).toBeDefined();
    net.live()[0]?.reset();

    for (let i = 0; i < 600 && !bot.done; i += 1) await clock.advance(1_000);
    expect(bot.played).toBe(1);
    expect(events.filter((event) => event.type === 'authed').length).toBeGreaterThanOrEqual(2);
    // The round it committed in was revealed after the reconnect, not missed.
    expect(events).toContainEqual({ type: 'revealed', round: committed?.type === 'committed' ? committed.round : -1 });
  });
});
