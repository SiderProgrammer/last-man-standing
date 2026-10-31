import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.js';

function counter() {
  let calls = 0;
  return {
    listener: () => {
      calls += 1;
    },
    get calls() {
      return calls;
    },
  };
}

describe('store', () => {
  it('runs a listener when one of its keys changes, and not for other keys', () => {
    const store = createStore({ round: 1, draft: null as string | null, deadline: 0 });
    const controls = counter();
    store.subscribe(['round', 'draft'], controls.listener);

    store.set({ deadline: 5_000 });
    expect(controls.calls).toBe(0);
    store.set({ draft: 'strike' });
    expect(controls.calls).toBe(1);
    expect(store.state.draft).toBe('strike');
  });

  it('runs each listener once per set, however many of its keys changed', () => {
    const store = createStore({ match: 'a', you: 0 });
    const table = counter();
    store.subscribe(['match', 'you'], table.listener);

    store.set({ match: 'b', you: 2 });
    expect(table.calls).toBe(1);
  });

  it('ignores a set that changes nothing', () => {
    const store = createStore({ oneClick: false });
    const panel = counter();
    store.subscribe(['oneClick'], panel.listener);

    store.set({ oneClick: false });
    expect(panel.calls).toBe(0);
  });

  /** Mutating a set in place is invisible to subscribers: a change is a new value. */
  it('hears a replaced collection, not a mutated one', () => {
    const store = createStore({ inTransit: new Set<string>() as ReadonlySet<string> });
    const lobbies = counter();
    store.subscribe(['inTransit'], lobbies.listener);

    store.set({ inTransit: new Set([...store.state.inTransit, '0xabc']) });
    expect(lobbies.calls).toBe(1);
    expect(store.state.inTransit.has('0xabc')).toBe(true);
  });

  it('has already applied the whole patch when a listener reads the state', () => {
    const store = createStore({ match: 'a', you: null as number | null });
    const seen: Array<[string, number | null]> = [];
    store.subscribe(['match'], () => seen.push([store.state.match, store.state.you]));

    store.set({ match: 'b', you: 3 });
    expect(seen).toEqual([['b', 3]]);
  });

  it('stops calling a listener once unsubscribed', () => {
    const store = createStore({ wallet: 0 });
    const panel = counter();
    const unsubscribe = store.subscribe(['wallet'], panel.listener);

    store.set({ wallet: 1 });
    unsubscribe();
    store.set({ wallet: 2 });
    expect(panel.calls).toBe(1);
  });
});
