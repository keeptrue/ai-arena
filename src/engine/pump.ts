/**
 * Live thinking is a *stream*: what the audience perceives is the update **rate**,
 * not the size of each update. A character threshold makes the feed slower the
 * longer the model thinks, so the cadence is the invariant here — one event per
 * FLUSH_MS, for the whole call.
 */

export const FLUSH_MS = Number(process.env.ARENA_FLUSH_MS ?? 80);
export const FLUSH_MAX_CHARS = Number(process.env.ARENA_FLUSH_MAX_CHARS ?? 4_096);
export const FLUSH_BUDGET = Number(process.env.ARENA_FLUSH_BUDGET ?? 600);
export const FLUSH_MAX_INTERVAL_MS = Number(process.env.ARENA_FLUSH_MAX_INTERVAL_MS ?? 1_000);

/** Per-pump overrides: a review ballot is not a seat turn, but it is the same stream. */
export interface PumpTuning {
  /** Base cadence in ms. */
  flushMs?: number;
  /** A single chunk this large ships immediately (burst protection). */
  maxChars?: number;
  /** Events per cadence step before the interval doubles. */
  budget?: number;
  /** Ceiling for the backed-off interval. */
  maxIntervalMs?: number;
}

/** How long to wait before the next live update. Doubles per budget, hard-capped. */
export function flushIntervalFor(emitted: number, tuning: PumpTuning = {}): number {
  const flushMs = tuning.flushMs ?? FLUSH_MS;
  const budget = Math.max(1, tuning.budget ?? FLUSH_BUDGET);
  const maxIntervalMs = Math.max(flushMs, tuning.maxIntervalMs ?? FLUSH_MAX_INTERVAL_MS);
  const steps = Math.floor(emitted / budget);
  if (steps <= 0) return flushMs;
  return Math.min(flushMs * 2 ** steps, maxIntervalMs);
}

export interface DeltaMeta {
  /** 1-based index of the event just emitted. */
  emitted: number;
  /** True once the cadence has backed off; carried to the UI as `coarse`. */
  backedOff: boolean;
}

/**
 * Coalescing pump for one live stream. Two triggers, one invariant:
 *   - size: `>= FLUSH_MAX_CHARS` ships at once (burst protection),
 *   - time: every `flushIntervalFor(emitted)` ships whatever has arrived, even 3 chars.
 * Nothing is ever dropped: `stop()` drains the remainder and releases the timer.
 */
export function openDeltaPump(emit: (delta: string, meta: DeltaMeta) => void, tuning: PumpTuning = {}) {
  const maxChars = Math.max(1, tuning.maxChars ?? FLUSH_MAX_CHARS);
  let buffer = "";
  let emitted = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const send = (delta: string) => {
    if (!delta) return;
    emitted += 1;
    emit(delta, {
      emitted,
      backedOff: flushIntervalFor(emitted, tuning) > (tuning.flushMs ?? FLUSH_MS),
    });
  };
  const drain = () => {
    if (!buffer) return;
    const delta = buffer;
    buffer = "";
    send(delta);
  };
  const burst = () => {
    while (buffer.length >= maxChars) {
      const delta = buffer.slice(0, maxChars);
      buffer = buffer.slice(maxChars);
      send(delta);
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      drain();
      schedule();
    }, flushIntervalFor(emitted, tuning));
  };
  schedule();

  return {
    push(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      burst();
    },
    drain,
    /** No more input: stop the clock, then flush the tail so the feed never ends mid-sentence. */
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      drain();
    },
    get emitted() {
      return emitted;
    },
  };
}
