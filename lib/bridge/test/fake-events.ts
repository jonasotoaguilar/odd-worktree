/**
 * A fake `pi.events`: Pi's cross-extension bus (`docs/extensions.md:1965-1972`).
 *
 * The real bus (`dist/core/event-bus.js`) is an `EventEmitter` behind two methods: `on(channel,
 * handler)` returns an unsubscribe function, and `emit(channel, data)` calls every handler. The
 * real handler wrapper is `async`, so a handler's *synchronous* work has completed by the time
 * `emit` returns — this fake delivers synchronously for the same reason, which is what lets a
 * bridge that publishes later register its plugin's surfaces during the emit.
 *
 * It counts listeners so a test can prove a plugin that found the API at load leaves nothing
 * behind, and records every emit so "exactly once per process" is observable.
 */

export type FakeEventHandler = (payload: unknown) => void;

export interface FakeEmit {
  channel: string;
  payload: unknown;
}

export interface FakeEvents {
  on(channel: string, handler: FakeEventHandler): () => void;
  emit(channel: string, payload?: unknown): void;
  /** Every `emit` this bus saw, in order. */
  emitted(): FakeEmit[];
  /** Live listeners on one channel, or on every channel when omitted. */
  listenerCount(channel?: string): number;
}

export function createFakeEvents(): FakeEvents {
  const listeners = new Map<string, Set<FakeEventHandler>>();
  const emits: FakeEmit[] = [];

  const count = (channel: string): number => listeners.get(channel)?.size ?? 0;

  return {
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set<FakeEventHandler>();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    emit(channel, payload) {
      emits.push({ channel, payload });
      // A copy, so a listener that unsubscribes while being notified cannot skip its neighbour.
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    },
    emitted: () => [...emits],
    listenerCount: (channel) => {
      if (channel !== undefined) return count(channel);
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}
