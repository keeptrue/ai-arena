import { describe, expect, test } from "bun:test";
import { forfeitReason, thinkingFlushThreshold } from "../src/engine/runtime";

describe("live thinking stream", () => {
  test("streams fine-grained, then coalesces instead of going silent", () => {
    expect(thinkingFlushThreshold(0)).toBe(64);
    expect(thinkingFlushThreshold(399)).toBe(64);
    // Past the chunk budget the audience still gets every character, just in blocks.
    expect(thinkingFlushThreshold(400)).toBe(2_048);
    expect(thinkingFlushThreshold(10_000)).toBe(2_048);
  });
});

describe("forfeit diagnostics", () => {
  test("names the missing-submit cutoff", () => {
    expect(
      forfeitReason({ runaway: true, elapsedMs: 150_400, timeoutMs: 180_000, message: "aborted" }),
    ).toContain("thinking_runaway");
  });

  test("names a hard call timeout instead of blaming the actor", () => {
    expect(
      forfeitReason({ runaway: false, elapsedMs: 180_003, timeoutMs: 180_000, message: "aborted" }),
    ).toContain("call_timeout");
  });

  test("keeps the provider error for genuine failures", () => {
    expect(
      forfeitReason({ runaway: false, elapsedMs: 3_000, timeoutMs: 180_000, message: "401 bad key" }),
    ).toBe("actor_failed: 401 bad key");
  });
});
