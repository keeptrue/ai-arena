import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { resetDbForTests, useMemoryDb } from "../src/db/client";
import {
  appendEvent,
  createMatch,
  dropCheckpoint,
  getMatch,
  hasCheckpoint,
  lastEventTs,
  loadCheckpoint,
  saveCheckpoint,
  setMatchStatus,
} from "../src/db/repo";
import type { AnyBlueprint } from "../src/engine/types";

/** Only stringified by the repo: the checkpoint store never reads the blueprint. */
const BLUEPRINT = { mode: "werewolf", id: "ww-fixture", name: "夹具" } as unknown as AnyBlueprint;

function seedMatch(id = "m-cp") {
  createMatch({
    id,
    rulesetId: "rs",
    blueprint: BLUEPRINT,
    seed: "seed-1",
    format: "9人",
    budget: { maxCalls: 10, maxTokens: 0 },
    judge: null,
    teams: [],
    participants: [],
  });
}

beforeEach(() => {
  useMemoryDb();
});

afterAll(() => {
  resetDbForTests();
});

describe("crash checkpoints", () => {
  test("a checkpoint round-trips through SQLite", () => {
    seedMatch();
    saveCheckpoint("m-cp", "werewolf", { v: 1, paused: false, state: { day: 2, phase: "night_wolves" } });

    const loaded = loadCheckpoint("m-cp");
    expect(loaded?.kind).toBe("werewolf");
    expect(loaded?.payload).toEqual({
      v: 1,
      paused: false,
      state: { day: 2, phase: "night_wolves" },
    });
    expect(hasCheckpoint("m-cp")).toBe(true);
  });

  test("a second write replaces the first, it never appends", () => {
    seedMatch();
    saveCheckpoint("m-cp", "werewolf", { state: { day: 1 } });
    saveCheckpoint("m-cp", "werewolf", { state: { day: 3 } });

    const loaded = loadCheckpoint("m-cp");
    expect((loaded?.payload as { state: { day: number } }).state.day).toBe(3);
  });

  test("dropping the checkpoint makes the match unresumable", () => {
    seedMatch();
    saveCheckpoint("m-cp", "rubric", { state: {} });
    dropCheckpoint("m-cp");
    expect(hasCheckpoint("m-cp")).toBe(false);
    expect(loadCheckpoint("m-cp")).toBeNull();
  });

  test("a missing row reads as null rather than throwing", () => {
    seedMatch();
    expect(loadCheckpoint("m-cp")).toBeNull();
    expect(hasCheckpoint("m-cp")).toBe(false);
  });

  test("lastEventTs is the newest timestamp, not the newest seq", () => {
    seedMatch();
    appendEvent("m-cp", { seq: 1, ts: 1_000, type: "match.created", payload: {} });
    appendEvent("m-cp", { seq: 2, ts: 5_000, type: "phase.changed", payload: {} });
    appendEvent("m-cp", { seq: 3, ts: 3_000, type: "seat.recalled", payload: {} });
    expect(lastEventTs("m-cp")).toBe(5_000);
  });
});

describe("resumability as the UI reads it", () => {
  test("a match is resumable only while it is unsettled AND has a checkpoint", () => {
    seedMatch();
    // Running but never checkpointed: the list must not promise a resume.
    expect(getMatch("m-cp")?.resumable).toBe(false);

    saveCheckpoint("m-cp", "werewolf", { v: 1 });
    expect(getMatch("m-cp")?.resumable).toBe(true);

    setMatchStatus("m-cp", "interrupted");
    expect(getMatch("m-cp")?.resumable).toBe(true);

    setMatchStatus("m-cp", "finished", { winnerTeamId: null, endReason: "wolves_out" });
    expect(getMatch("m-cp")?.resumable).toBe(false);
  });
});
