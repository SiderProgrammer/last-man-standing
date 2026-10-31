/**
 * A typed store with subscriptions by key.
 *
 * State changes only through `set`, and whatever draws a part of it
 * subscribes to the keys it reads. That splits the client in two: actions —
 * server messages, clicks, timers — change state and are the only code that
 * sends anything; renderers redraw from state and send nothing. A renderer
 * runs again when a key it listens to changes, whoever changed it, so no
 * action has to remember which panels to redraw.
 *
 * A change is a new value: `Object.is` decides, so a set or an object is
 * replaced rather than mutated in place, or nobody hears about it.
 */
export interface Store<T extends object> {
  /** The current state. Read freely; write only through `set`. */
  readonly state: Readonly<T>;
  /** Applies `patch`, then runs every listener on a key whose value changed, once each. */
  set(patch: Partial<T>): void;
  /** Runs `listener` after each `set` that changes one of `keys`. Returns the unsubscribe. */
  subscribe(keys: readonly (keyof T)[], listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  const state = { ...initial };
  const subscriptions = new Set<{ keys: ReadonlySet<keyof T>; listener: () => void }>();

  return {
    state,
    set(patch) {
      const changed: Array<keyof T> = [];
      for (const key of Object.keys(patch) as Array<keyof T>) {
        const value = patch[key] as T[keyof T];
        if (Object.is(state[key], value)) continue;
        state[key] = value;
        changed.push(key);
      }
      if (changed.length === 0) return;
      // A copy: a listener may subscribe or unsubscribe as it runs.
      for (const subscription of [...subscriptions]) {
        if (changed.some((key) => subscription.keys.has(key))) subscription.listener();
      }
    },
    subscribe(keys, listener) {
      const subscription = { keys: new Set(keys), listener };
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    },
  };
}
