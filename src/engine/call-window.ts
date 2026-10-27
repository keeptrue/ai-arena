/**
 * Shared timing for one model call: a total ceiling that caps billing, a silence
 * detector that is the real "this stream is dead" signal, and the vocabulary for
 * explaining which one fired.
 *
 * Kept apart from `runtime.ts` so the werewolf runtime can use it without an
 * import cycle through `startMatch`.
 */

export const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.ARENA_CALL_TIMEOUT_MS ?? 1_800_000);
export const STALL_MS = Number(process.env.ARENA_STALL_MS ?? 180_000);
export const MIN_CALL_TIMEOUT_MS = 60_000;
export const MAX_CALL_TIMEOUT_MS = 7_200_000;
export const MAX_THINKING_CHARS = Number(process.env.ARENA_MAX_THINKING_CHARS ?? 2_000_000);
export const REPEAT_WINDOW = 60;
export const REPEAT_LIMIT = 6;
/** How many times one turn may be re-opened after a silence cut that produced nothing. */
export const STALL_RETRY = Number(process.env.ARENA_STALL_RETRY ?? 1);

export type CallCut = "ceiling" | "stall" | "loop" | "size";

/** A model's own ceiling wins; otherwise the global default (0 there = unlimited). */
export function callTimeoutFor(
  model: { callTimeoutMs?: number | null },
  fallback = DEFAULT_CALL_TIMEOUT_MS,
): number {
  const own = model.callTimeoutMs;
  if (typeof own === "number" && Number.isFinite(own) && own > 0) return own;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : Infinity;
}

/**
 * Which deadline, if any, has arrived. Silence and total elapsed time are different
 * failures: silence means the stream died, elapsed time only means the model is slow.
 */
export function watchdogCut(input: {
  elapsedMs: number;
  idleMs: number;
  timeoutMs: number;
  stallMs: number;
}): "ceiling" | "stall" | null {
  if (Number.isFinite(input.timeoutMs) && input.elapsedMs >= input.timeoutMs) return "ceiling";
  if (Number.isFinite(input.stallMs) && input.stallMs > 0 && input.idleMs >= input.stallMs) {
    return "stall";
  }
  return null;
}

/**
 * Is a silence cut worth one more attempt?
 *
 * Only a window that received *nothing at all* is worth re-opening: a model that
 * already produced text has spent its thinking, and retrying would bill the same
 * work twice and risk a second, different answer. Transport silence with zero
 * bytes is the shape a dead connection and a stalled gateway share, and it is the
 * one case where a fresh attempt is free of ambiguity.
 */
export function shouldRetryStall(input: {
  cut: CallCut | null;
  /** Characters received during *this* attempt, not the whole turn. */
  receivedChars: number;
  retriesUsed: number;
}): boolean {
  if (input.cut !== "stall") return false;
  if (input.receivedChars > 0) return false;
  return input.retriesUsed < Math.max(0, STALL_RETRY);
}

/**
 * One logical call's budget: a total ceiling plus a silence detector, polled once a
 * second so a gateway that stops sending anything is caught even when no delta ever
 * arrives. `touch()` on every delta keeps a legitimately slow model alive, and
 * `touch()` on every byte (provider `onBeat`) keeps a live connection with no body
 * from being mistaken for a dead one.
 */
export function openCallWindow(input: { timeoutMs: number; stallMs: number }) {
  const controller = new AbortController();
  let started = Date.now();
  let last = started;
  let cut: CallCut | null = null;
  const timer = setInterval(() => {
    if (cut) return;
    const next = watchdogCut({
      elapsedMs: Date.now() - started,
      idleMs: Date.now() - last,
      timeoutMs: input.timeoutMs,
      stallMs: input.stallMs,
    });
    if (!next) return;
    cut = next;
    controller.abort();
  }, 1_000);
  return {
    signal: controller.signal,
    touch() {
      last = Date.now();
    },
    cut: (): CallCut | null => cut,
    idleMs: () => Date.now() - last,
    elapsedMs: () => Date.now() - started,
    abort(reason: CallCut) {
      if (!cut) cut = reason;
      controller.abort();
    },
    /** A retry is a new attempt: restart the clock instead of inheriting a spent one. */
    rearm() {
      started = Date.now();
      last = started;
    },
    close() {
      clearInterval(timer);
    },
  };
}

function minutesLabel(ms: number): string {
  if (!Number.isFinite(ms)) return "无限";
  const minutes = ms / 60_000;
  return minutes >= 1 ? `${Math.round(minutes)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** Why a participant turn ended without a submission. Exported for tests. */
export function forfeitReason(input: {
  cut: CallCut | null;
  elapsedMs: number;
  idleMs: number;
  timeoutMs: number;
  message: string;
}): string {
  const seconds = Math.round(input.elapsedMs / 1000);
  switch (input.cut) {
    case "stall":
      return `stream_stalled: ${Math.round(input.idleMs / 1000)} 秒没有新内容，已中止`;
    case "ceiling":
      return `call_timeout: 已到 ${minutesLabel(input.timeoutMs)}总时限（${seconds} 秒），主动中止`;
    case "loop":
      return "thinking_loop: 同一段内容反复出现，已截断";
    case "size":
      return `thinking_too_long: 思考超过 ${MAX_THINKING_CHARS} 字符，已截断`;
    default:
      return `actor_failed: ${input.message}`;
  }
}

/** What actually stopped a call, plus when. Shared by participant and judge paths. */
export interface CallCutInfo {
  cut: CallCut;
  elapsedMs: number;
  idleMs: number;
  timeoutMs: number;
}

/** Aborts read the same in every provider; this is the human-readable cause. */
export function failureMessage(cut: CallCutInfo | null, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return cut ? forfeitReason({ ...cut, message }) : message;
}
