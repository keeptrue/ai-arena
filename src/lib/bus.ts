import type { ArenaEvent, EventType } from "@/engine/types";
import { eventsAfter } from "@/db/repo";

type Listener = (event: ArenaEvent) => void;

// Shared across route bundles: each Next route gets its own module graph.
const G = globalThis as unknown as { __arenaBus?: Map<string, Set<Listener>> };
const listeners: Map<string, Set<Listener>> = (G.__arenaBus ??= new Map<string, Set<Listener>>());

export function publish(matchId: string, event: ArenaEvent): void {
  const set = listeners.get(matchId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* a dead subscriber must not break the match */
    }
  }
}

export function subscribe(matchId: string, fn: Listener): () => void {
  let set = listeners.get(matchId);
  if (!set) {
    set = new Set();
    listeners.set(matchId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(matchId);
  };
}

/**
 * Gap-free stream: subscribe first, then replay history from the DB, then drain
 * the live queue. Events are written to the DB before being published, so no
 * event can slip between the replay and the subscription.
 */
export async function* streamEvents(
  matchId: string,
  after: number,
  signal: AbortSignal,
): AsyncGenerator<ArenaEvent> {
  const queue: ArenaEvent[] = [];
  let wake: (() => void) | null = null;

  const unsubscribe = subscribe(matchId, (event) => {
    queue.push(event);
    wake?.();
  });

  try {
    let last = after;
    for (const event of eventsAfter(matchId, after)) {
      last = Math.max(last, event.seq);
      yield event;
    }

    for (;;) {
      if (signal.aborted) return;
      if (queue.length > 0) {
        const event = queue.shift()!;
        if (event.seq > last) {
          last = event.seq;
          yield event;
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = () => resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      wake = null;
    }
  } finally {
    unsubscribe();
  }
}
