import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  FLUSH_BUDGET,
  FLUSH_MAX_CHARS,
  FLUSH_MS,
  STALL_MS,
  STALL_RETRY,
  callTimeoutFor,
  flushIntervalFor,
  forfeitReason,
  openDeltaPump,
  shouldRetryStall,
  watchdogCut,
} from "../src/engine/runtime";
import type { ModelSnapshot } from "../src/engine/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live thinking cadence", () => {
  test("an ordinary long answer never leaves the fast cadence", () => {
    // ~30 000 characters at ~690 chars/s ≈ 45 s ≈ 560 events at the default cadence,
    // so a stream the audience complains about is still well inside the budget.
    expect(flushIntervalFor(0)).toBe(FLUSH_MS);
    expect(flushIntervalFor(FLUSH_BUDGET - 1)).toBe(FLUSH_MS);
  });

  test("past the budget the interval doubles instead of the payload", () => {
    expect(flushIntervalFor(FLUSH_BUDGET)).toBe(FLUSH_MS * 2);
    expect(flushIntervalFor(FLUSH_BUDGET * 2)).toBe(FLUSH_MS * 4);
  });

  test("a marathon call backs off to a ceiling, never to silence", () => {
    const far = flushIntervalFor(FLUSH_BUDGET * 50);
    expect(far).toBeGreaterThan(FLUSH_MS);
    expect(far).toBeLessThanOrEqual(1_000);
  });

  test("time drives the update: three characters still reach the screen", async () => {
    const seen: string[] = [];
    const pump = openDeltaPump((delta) => seen.push(delta));
    try {
      pump.push("我要");
      pump.push("说");
      // Size alone would hold this back forever; the cadence timer must ship it.
      expect(seen.join("")).toBe("");
      await sleep(FLUSH_MS * 3);
      expect(seen.join("")).toBe("我要说");

      // The clock keeps running, so a later trickle is shipped without any size trigger.
      pump.push("完");
      await sleep(FLUSH_MS * 3);
      expect(seen.join("")).toBe("我要说完");
      expect(seen).toHaveLength(2);
    } finally {
      pump.stop();
    }
  });

  test("a 20 000-character dump is split instead of shipped as one frame", () => {
    const sizes: number[] = [];
    const pump = openDeltaPump((delta) => sizes.push(delta.length));
    try {
      pump.push("字".repeat(20_000));
      expect(sizes.every((n) => n <= FLUSH_MAX_CHARS)).toBe(true);
      expect(sizes.length).toBeGreaterThan(1);
    } finally {
      pump.stop();
    }
    // Burst splitting is not truncation: every character still arrives.
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(20_000);
  });

  test("a pump can run on its own budget (review ballots back off sooner)", () => {
    // A review ballot is still a call: same cadence family, its own scale.
    const tuning = { flushMs: 40, budget: 2 };
    expect(flushIntervalFor(0, tuning)).toBe(40);
    expect(flushIntervalFor(1, tuning)).toBe(40);
    expect(flushIntervalFor(2, tuning)).toBe(80);
    expect(flushIntervalFor(4, tuning)).toBe(160);
    // The ceiling is per-pump and never below the base cadence.
    expect(flushIntervalFor(100, { flushMs: 40, budget: 1, maxIntervalMs: 100 })).toBe(100);
    expect(flushIntervalFor(100, { flushMs: 400, budget: 1, maxIntervalMs: 100 })).toBe(400);
  });

  test("a tuned pump splits on its own chunk size", () => {
    const sizes: number[] = [];
    const pump = openDeltaPump((delta) => sizes.push(delta.length), { maxChars: 4 });
    try {
      pump.push("一二三四五六七八九十");
      expect(sizes).toEqual([4, 4]);
    } finally {
      pump.stop();
    }
    // The remainder is the tail: no character is lost when the call ends.
    expect(sizes).toEqual([4, 4, 2]);
  });

  test("stop() flushes the tail so the feed never ends mid-sentence", () => {
    const seen: string[] = [];
    const pump = openDeltaPump((delta) => seen.push(delta));
    pump.push("半句话");
    pump.stop();
    expect(seen.join("")).toBe("半句话");
  });
});

describe("call ceiling resolution", () => {
  const model = (callTimeoutMs?: number | null) => ({ callTimeoutMs }) as Pick<
    ModelSnapshot,
    "callTimeoutMs"
  >;

  test("inherits the global default when the model has none", () => {
    expect(callTimeoutFor(model(null))).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(callTimeoutFor(model(undefined))).toBe(DEFAULT_CALL_TIMEOUT_MS);
  });

  test("a model that thinks longer gets its own ceiling", () => {
    expect(callTimeoutFor(model(4_500_000))).toBe(4_500_000);
  });

  test("a zero or negative override falls back instead of banning thought", () => {
    expect(callTimeoutFor(model(0))).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(callTimeoutFor(model(-1))).toBe(DEFAULT_CALL_TIMEOUT_MS);
  });

  test("a disabled global ceiling means no deadline at all", () => {
    expect(callTimeoutFor(model(null), 0)).toBe(Number.POSITIVE_INFINITY);
    expect(callTimeoutFor(model(undefined), 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("watchdog", () => {
  test("a model that keeps emitting is never cut, however long it thinks", () => {
    expect(
      watchdogCut({
        elapsedMs: 20 * 60_000,
        idleMs: 800,
        timeoutMs: 30 * 60_000,
        stallMs: STALL_MS,
      }),
    ).toBeNull();
  });

  test("silence is the failure signature", () => {
    expect(
      watchdogCut({
        elapsedMs: 200_000,
        idleMs: STALL_MS,
        timeoutMs: 1_800_000,
        stallMs: STALL_MS,
      }),
    ).toBe("stall");
  });

  test("the ceiling is a billing backstop, not a verdict on thinking", () => {
    expect(
      watchdogCut({
        elapsedMs: 1_800_000,
        idleMs: 500,
        timeoutMs: 1_800_000,
        stallMs: STALL_MS,
      }),
    ).toBe("ceiling");
  });

  test("an unlimited ceiling never fires", () => {
    expect(
      watchdogCut({
        elapsedMs: 1_000_000_000,
        idleMs: 500,
        timeoutMs: Number.POSITIVE_INFINITY,
        stallMs: STALL_MS,
      }),
    ).toBeNull();
  });

  test("a zero stall budget disables the silence detector", () => {
    expect(
      watchdogCut({
        elapsedMs: 60_000,
        idleMs: 1_000_000_000,
        timeoutMs: Number.POSITIVE_INFINITY,
        stallMs: 0,
      }),
    ).toBeNull();
  });
});

describe("forfeit diagnostics", () => {
  const base = { elapsedMs: 200_000, idleMs: 190_000, timeoutMs: 1_800_000, message: "aborted" };

  test("names the silence cutoff", () => {
    expect(forfeitReason({ ...base, cut: "stall" })).toContain("stream_stalled");
  });

  test("names the ceiling", () => {
    expect(forfeitReason({ ...base, cut: "ceiling" })).toContain("call_timeout");
  });

  test("names a loop", () => {
    expect(forfeitReason({ ...base, cut: "loop" })).toContain("thinking_loop");
  });

  test("names the memory backstop", () => {
    expect(forfeitReason({ ...base, cut: "size" })).toContain("thinking_too_long");
  });

  test("keeps the provider error for genuine failures", () => {
    expect(forfeitReason({ ...base, cut: null, message: "401 bad key" })).toBe(
      "actor_failed: 401 bad key",
    );
  });
});

describe("silence retry", () => {
  test("a window that received nothing is worth one more attempt", () => {
    // The shape a dead gateway and a very slow model share: no bytes at all.
    expect(shouldRetryStall({ cut: "stall", receivedChars: 0, retriesUsed: 0 })).toBe(
      Math.max(0, STALL_RETRY) > 0,
    );
  });

  test("a model that already spoke is never retried", () => {
    // It spent its thinking once; a second attempt would bill it twice and could
    // come back with a different answer for the same turn.
    expect(shouldRetryStall({ cut: "stall", receivedChars: 1, retriesUsed: 0 })).toBe(false);
    expect(shouldRetryStall({ cut: "stall", receivedChars: 40_000, retriesUsed: 0 })).toBe(false);
  });

  test("only silence is retried, never a verdict", () => {
    expect(shouldRetryStall({ cut: "ceiling", receivedChars: 0, retriesUsed: 0 })).toBe(false);
    expect(shouldRetryStall({ cut: "loop", receivedChars: 0, retriesUsed: 0 })).toBe(false);
    expect(shouldRetryStall({ cut: "size", receivedChars: 0, retriesUsed: 0 })).toBe(false);
    expect(shouldRetryStall({ cut: null, receivedChars: 0, retriesUsed: 0 })).toBe(false);
  });

  test("the allowance is spent after the configured attempts", () => {
    const budget = Math.max(0, STALL_RETRY);
    expect(shouldRetryStall({ cut: "stall", receivedChars: 0, retriesUsed: budget })).toBe(false);
  });
});
