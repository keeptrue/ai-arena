/**
 * Fan-out gate for explicit prompt caches.
 *
 * A phase calls nine seats at once and they all read the same prefix. On a provider
 * that caches automatically this costs nothing extra, but on one that charges for
 * the *write* (Anthropic: 1.25x) nine simultaneous misses pay nine writes. Letting
 * one call go first and releasing the rest when its first byte lands turns that into
 * one write plus eight reads (~2x instead of ~11x), at the price of one time-to-first-
 * byte for the seats that wait.
 *
 * The gate is deliberately dumb: one promise per key, released by the caller's first
 * byte, its failure, or a hard ceiling — whichever comes first. It never reorders
 * results (the reducer does not care who answers first) and it never holds a call
 * forever.
 */

export type Release = () => void;

export interface CacheGate {
  /**
   * Wait for the prefix to be warm, then return the function that reports "warm".
   * The caller that arrives first gets a no-op wait and owns the release.
   */
  acquire(key: string): Promise<Release>;
}

export interface CacheGateOptions {
  /** Ceiling on how long a waiter may be held; 0 disables the wait entirely. */
  holdMs?: number;
}

const NOOP: Release = () => {};

export function createCacheGate(options: CacheGateOptions = {}): CacheGate {
  const holdMs = Math.max(0, options.holdMs ?? 3_000);
  const warmed = new Map<string, Promise<void>>();

  return {
    async acquire(key: string): Promise<Release> {
      if (holdMs === 0) return NOOP;
      const pending = warmed.get(key);
      if (!pending) {
        let open: () => void = NOOP;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        // A warmer that dies before its first byte must not strand the table.
        const timer = setTimeout(open, holdMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        warmed.set(key, gate);
        return () => {
          clearTimeout(timer);
          open();
        };
      }
      await pending;
      return NOOP;
    },
  };
}

/** Only providers with a write-charging cache need the gate; everyone else runs free. */
export function gateKeyFor(scope: string, model: { providerCacheMode?: string | null }): string | null {
  return model.providerCacheMode === "explicit" ? scope : null;
}
