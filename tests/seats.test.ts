import { describe, expect, test } from "bun:test";
import { duplicateMarks, mirrorSides, rosterTwins, seatList, seatsByModel } from "../src/lib/seats";

describe("seatsByModel", () => {
  test("groups seats by model and skips unfilled slots", () => {
    const map = seatsByModel(["a", "", "b", null, "a", undefined]);
    expect([...map.entries()]).toEqual([
      ["a", [0, 4]],
      ["b", [2]],
    ]);
  });

  test("an entirely empty roster yields no entries", () => {
    expect(seatsByModel(["", "", ""]).size).toBe(0);
  });
});

describe("duplicateMarks", () => {
  test("a clean roster has no marks at all", () => {
    expect(duplicateMarks(["a", "b", "c"])).toEqual([null, null, null]);
  });

  test("unfilled seats are never duplicates", () => {
    expect(duplicateMarks(["", "", "a", "a"])).toEqual([null, null, [3], [2]]);
  });

  test("three seats on one model each point at the other two", () => {
    expect(duplicateMarks(["a", "b", "a", "a"])).toEqual([[2, 3], null, [0, 3], [0, 2]]);
  });

  test("two independent pairs do not bleed into each other", () => {
    expect(duplicateMarks(["a", "a", "b", "b"])).toEqual([[1], [0], [3], [2]]);
  });
});

describe("rosterTwins", () => {
  test("reports one group per shared model, in first-seat order", () => {
    const twins = rosterTwins(["a", "b", "b", "", "a"]);
    expect(twins.groups).toEqual([
      { modelId: "a", seats: [0, 4] },
      { modelId: "b", seats: [1, 2] },
    ]);
    expect(twins.marks).toEqual([[4], [2], [1], null, [0]]);
  });

  test("marks and groups agree on a four-seat mirror table", () => {
    const twins = rosterTwins(["a", "a", "a", "a"]);
    expect(twins.groups).toEqual([{ modelId: "a", seats: [0, 1, 2, 3] }]);
    for (let seat = 0; seat < 4; seat += 1) {
      expect(twins.marks[seat]).toHaveLength(3);
      expect(twins.marks[seat]).not.toContain(seat);
    }
  });
});

describe("mirrorSides", () => {
  test("the same model on both sides of a duel is a mirror", () => {
    expect(mirrorSides([{ modelIds: ["a"] }, { modelIds: ["a"] }])).toEqual([
      { modelId: "a", sides: [0, 1] },
    ]);
  });

  test("repeating a model inside one side is not a mirror", () => {
    expect(mirrorSides([{ modelIds: ["a", "a"] }, { modelIds: ["b"] }])).toEqual([]);
  });

  test("three sides are listed without duplicates", () => {
    expect(
      mirrorSides([{ modelIds: ["a", "a"] }, { modelIds: ["b"] }, { modelIds: ["a"] }]),
    ).toEqual([{ modelId: "a", sides: [0, 2] }]);
  });

  test("a three-cornered roster reports every side a model plays for", () => {
    expect(mirrorSides([{ modelIds: ["a"] }, { modelIds: ["a"] }, { modelIds: ["a"] }])).toEqual([
      { modelId: "a", sides: [0, 1, 2] },
    ]);
  });
});

describe("seatList", () => {
  test("numbers seats from one and joins with a separator", () => {
    expect(seatList([0, 6])).toBe("#1、#7");
    expect(seatList([2])).toBe("#3");
    expect(seatList([])).toBe("");
  });
});
