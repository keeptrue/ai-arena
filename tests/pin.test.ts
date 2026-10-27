import { describe, expect, test } from "bun:test";
import {
  PIN_TTL_MS,
  decidePin,
  parsePin,
  pinAfterPulse,
  pinPhaseLabel,
  pinProgress,
  pinVisibleOn,
  samePin,
  type MatchPin,
} from "../src/lib/pin";

const NOW = 1_700_000_000_000;

function pin(over: Partial<MatchPin> = {}): MatchPin {
  return {
    id: "m1",
    kind: "rubric",
    name: "罐中论剑",
    phase: "collecting",
    round: 2,
    rounds: 8,
    settled: 1,
    seats: 2,
    ts: NOW,
    ...over,
  };
}

function raw(over: Partial<MatchPin> = {}, now = NOW): string {
  return JSON.stringify(pin({ ts: now, ...over }));
}

describe("parsePin", () => {
  test("round-trips a record written by the arena", () => {
    expect(parsePin(raw(), NOW)).toEqual(pin());
  });

  test("treats absent, malformed and non-object data as no pin", () => {
    expect(parsePin(null)).toBeNull();
    expect(parsePin("")).toBeNull();
    expect(parsePin("not json")).toBeNull();
    expect(parsePin("null")).toBeNull();
    expect(parsePin("[]")).toBeNull();
    expect(parsePin("{}")).toBeNull();
  });

  test("rejects wrong shapes instead of coercing them", () => {
    expect(parsePin(JSON.stringify(pin({ id: "  " as string })), NOW)).toBeNull();
    expect(parsePin(JSON.stringify({ ...pin(), phase: "victory" }), NOW)).toBeNull();
    expect(parsePin(JSON.stringify({ ...pin(), round: "2" }), NOW)).toBeNull();
    expect(parsePin(JSON.stringify({ ...pin(), settled: null }), NOW)).toBeNull();
    expect(parsePin(JSON.stringify({ ...pin(), ts: -1 }), NOW)).toBeNull();
  });

  test("drops records older than the TTL and keeps fresh ones", () => {
    expect(parsePin(raw({}, NOW - PIN_TTL_MS - 1), NOW)).toBeNull();
    expect(parsePin(raw({}, NOW - PIN_TTL_MS + 1), NOW)).not.toBeNull();
  });

  test("trims and caps the display name", () => {
    const parsed = parsePin(JSON.stringify({ ...pin(), name: `  ${"长".repeat(100)}  ` }), NOW);
    expect(parsed?.name).toBe("长".repeat(80));
    expect(parsePin(JSON.stringify({ ...pin(), name: "   " }), NOW)).toBeNull();
  });

  test("clamps settled seats to the roster size", () => {
    expect(parsePin(raw({ settled: 5, seats: 2 }), NOW)?.settled).toBe(2);
    // seats unknown (0) means we cannot clamp, so the number is kept as written.
    expect(parsePin(raw({ settled: 3, seats: 0 }), NOW)?.settled).toBe(3);
  });
});

describe("decidePin", () => {
  test("claims the chip when nothing is pinned", () => {
    const next = pin();
    expect(decidePin(null, next)).toBe(next);
  });

  test("updates the same match in place", () => {
    const prev = pin({ round: 1, phase: "judging" });
    const next = pin({ round: 2, phase: "collecting" });
    expect(decidePin(prev, next)).toBe(next);
  });

  test("a replay never displaces a live match", () => {
    const live = pin({ id: "live", phase: "collecting" });
    const replay = pin({ id: "old", phase: "done" });
    expect(decidePin(live, replay)).toBe(live);
  });

  test("a live match takes over from an archived one", () => {
    const archived = pin({ id: "old", phase: "done" });
    const live = pin({ id: "live", phase: "collecting" });
    expect(decidePin(archived, live)).toBe(live);
  });

  test("between two archived matches the newer sighting wins", () => {
    const prev = pin({ id: "a", phase: "done" });
    const next = pin({ id: "b", phase: "done" });
    expect(decidePin(prev, next)).toBe(next);
  });

  test("identical readings keep the previous object so nothing is written", () => {
    const prev = pin();
    const next = pin({ ts: NOW + 5000 });
    expect(samePin(prev, next)).toBe(true);
    expect(decidePin(prev, next)).toBe(prev);
  });
});

describe("pinVisibleOn", () => {
  test("hides only on the match it points at", () => {
    expect(pinVisibleOn("/", pin())).toBe(true);
    expect(pinVisibleOn("/arena/m1", pin())).toBe(false);
    expect(pinVisibleOn("/arena/m1/", pin())).toBe(false);
    expect(pinVisibleOn("/arena/m2", pin())).toBe(true);
    expect(pinVisibleOn("/matches", pin())).toBe(true);
  });

  test("without a pin there is nothing to show", () => {
    expect(pinVisibleOn("/matches", null)).toBe(false);
  });
});

describe("pinAfterPulse", () => {
  test("advances the closed-round count without touching the phase", () => {
    const current = pin({ round: 2, phase: "collecting" });
    const next = pinAfterPulse(current, { status: "running", rounds: 4 }, NOW + 1);
    expect(next.round).toBe(4);
    expect(next.phase).toBe("collecting");
    expect(next.ts).toBe(NOW + 1);
  });

  test("marks the pin finished once the match is no longer running", () => {
    const current = pin({ round: 2, phase: "judging" });
    expect(pinAfterPulse(current, { status: "finished", rounds: 2 }, NOW + 1).phase).toBe("done");
    expect(pinAfterPulse(current, { status: "interrupted", rounds: 2 }, NOW + 1).phase).toBe("done");
  });

  test("never reopens a finished pin or regresses the round count", () => {
    const done = pin({ phase: "done", round: 8 });
    expect(pinAfterPulse(done, { status: "running", rounds: 3 }, NOW + 1)).toBe(done);
  });

  test("ignores unreadable pulse fields", () => {
    const current = pin();
    expect(pinAfterPulse(current, { status: "running", rounds: "4" }, NOW + 1)).toBe(current);
    expect(pinAfterPulse(current, {}, NOW + 1)).toBe(current);
    expect(pinAfterPulse(current, { status: "running", rounds: -2 }, NOW + 1)).toBe(current);
  });
});

describe("labels", () => {
  test("renders progress with a placeholder for unknown totals", () => {
    expect(pinProgress(pin({ round: 3, rounds: 8 }))).toBe("3/8 轮");
    expect(pinProgress(pin({ round: 0, rounds: 0 }))).toBe("0/? 轮");
  });

  test("names every phase", () => {
    expect(pinPhaseLabel("connecting")).toBe("连接中");
    expect(pinPhaseLabel("collecting")).toBe("出招中");
    expect(pinPhaseLabel("judging")).toBe("裁决中");
    expect(pinPhaseLabel("paused")).toBe("已暂停");
    expect(pinPhaseLabel("done")).toBe("已终局");
  });
});

describe("kind-aware pins", () => {
  test("an old record without kind is a rubric pin", () => {
    const raw = JSON.stringify({ ...pin(), kind: undefined });
    expect(parsePin(raw, NOW)?.kind).toBe("rubric");
  });

  test("a werewolf pin reopens the table, not the arena", () => {
    const wolf = pin({ kind: "werewolf", name: "预女猎九人局" });
    expect(pinVisibleOn("/table/m1", wolf)).toBe(false);
    expect(pinVisibleOn("/arena/m1", wolf)).toBe(true);
    expect(pinVisibleOn("/table/m1", pin())).toBe(true);
    expect(pinVisibleOn("/arena/m1", pin())).toBe(false);
  });

  test("changing kind counts as a new sighting", () => {
    expect(samePin(pin({ kind: "werewolf" }), pin({ kind: "rubric" }))).toBe(false);
  });
});

describe("werewolf pin labels", () => {
  test("counts days instead of rounds", () => {
    expect(pinProgress(pin({ kind: "werewolf", round: 3, rounds: 8 }))).toBe("3/8 天");
    expect(pinProgress(pin())).toBe("2/8 轮");
  });
});
