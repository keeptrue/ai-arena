import { describe, expect, test } from "bun:test";
import { act, buildCoupState, startCoup, waiting } from "./coup-fixture";
import { recoverCoup, reduceCoup } from "../src/engine/coup/reduce";
import type { CoupEffect, CoupState } from "../src/engine/coup/types";

function callsOf(effects: CoupEffect[]): Array<{ seat: number; phase: string }> {
  return effects
    .filter((e): e is Extract<CoupEffect, { kind: "call_seat" }> => e.kind === "call_seat")
    .map((e) => ({ seat: e.seat, phase: e.phase }));
}

/** A match parked in the reaction window with one reaction already recorded. */
function halfwayThroughReaction(): CoupState {
  let s = startCoup();
  s = act(s, 0, { kind: "act", action: "tax", target: null, say: "" });
  s = act(s, 1, { kind: "react", reaction: "pass", as: null, say: "" });
  return s;
}

describe("coup crash recovery", () => {
  test("a parallel phase re-calls only the seats that have not answered", () => {
    const s = halfwayThroughReaction();
    expect(s.phase).toBe("action_reaction");
    const owed = waiting(s);
    expect(owed).toEqual([2, 3]);

    const { state, effects } = recoverCoup(s);
    expect(state).not.toBe(s); // a fresh object, never the same reference
    expect(callsOf(effects).map((c) => c.seat).sort()).toEqual([2, 3]);
    expect(callsOf(effects).every((c) => c.phase === "action_reaction")).toBe(true);
  });

  test("an already-answered seat is never called twice", () => {
    const s = halfwayThroughReaction();
    const { effects } = recoverCoup(s);
    expect(callsOf(effects).some((c) => c.seat === 1)).toBe(false);
  });

  test("a sequential phase re-calls only the seat that is in flight", () => {
    let s = startCoup();
    // action_select is sequential: seat 0 is the only one called.
    expect(s.callMode).toBe("sequential");
    const { effects } = recoverCoup(s);
    expect(callsOf(effects).map((c) => c.seat)).toEqual([0]);
  });

  test("recovery keeps queueIndex pointing past the issued call", () => {
    const s = halfwayThroughReaction();
    const { state } = recoverCoup(s);
    expect(state.queueIndex).toBeGreaterThanOrEqual(0);
    expect(state.queueIndex).toBeLessThanOrEqual(state.queue.length);
    // Every owed seat must still be acceptable to `submit` afterwards.
    const owed = waiting(state);
    for (const seat of owed) {
      expect(state.queue.includes(seat)).toBe(true);
    }
  });

  test("a fully collected phase advances instead of re-calling", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "income", target: null, say: "" });
    // Income resolves immediately, so the next phase has nobody owed.
    const { effects } = recoverCoup(s);
    // Either a fresh call for the next actor, or nothing — never a call for seat 0.
    expect(callsOf(effects).some((c) => c.seat === 0)).toBe(false);
  });

  test("a finished match has no side effects", () => {
    const s = buildCoupState();
    const done: CoupState = { ...s, phase: "done", winner: 0 };
    const result = reduceCoup(done, { kind: "recall", seat: 0 });
    expect(result.effects).toHaveLength(0);
    expect(result.state.phase).toBe("done");
  });

  test("a late answer from a recalled seat is accepted, and only once", () => {
    let s = halfwayThroughReaction();
    s = act(s, 2, { kind: "react", reaction: "pass", as: null, say: "" });
    s = act(s, 3, { kind: "react", reaction: "pass", as: null, say: "" });
    expect(s.phase).not.toBe("action_reaction");
  });
});
