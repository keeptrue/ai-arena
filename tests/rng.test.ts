import { describe, expect, test } from "bun:test";
import { fnv1a, mulberry32, roll, shuffle, signedRoll } from "../src/engine/rng";

describe("deterministic rng", () => {
  test("same tuple always yields the same value", () => {
    const a = roll("seed-1", 3, 1, "hit:0");
    const b = roll("seed-1", 3, 1, "hit:0");
    expect(a).toBe(b);
  });

  test("different salts decorrelate", () => {
    const values = new Set<string>();
    for (let i = 0; i < 200; i++) values.add(roll("s", 1, 0, `salt:${i}`).toFixed(6));
    expect(values.size).toBeGreaterThan(190);
  });

  test("values are order independent (no shared cursor)", () => {
    const forward = [roll("s", 1, 0, "a"), roll("s", 1, 0, "b"), roll("s", 1, 0, "c")];
    const backward = [roll("s", 1, 0, "c"), roll("s", 1, 0, "b"), roll("s", 1, 0, "a")].reverse();
    expect(forward).toEqual(backward);
  });

  test("stays inside [0,1) and signed roll inside [-1,1)", () => {
    for (let i = 0; i < 500; i++) {
      const v = roll("x", i % 12, i % 3, "k");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const s = signedRoll("x", i % 12, i % 3, "k");
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThan(1);
    }
  });

  test("shuffle is a stable permutation and seed sensitive", () => {
    const a = shuffle([1, 2, 3, 4, 5, 6], "seed", "salt");
    const b = shuffle([1, 2, 3, 4, 5, 6], "seed", "salt");
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    const c = shuffle([1, 2, 3, 4, 5, 6], "different", "salt");
    expect(c).not.toEqual(a);
  });

  test("fnv1a / mulberry32 are stable", () => {
    expect(fnv1a("arena")).toBe(fnv1a("arena"));
    expect(mulberry32(fnv1a("arena"))()).toBe(mulberry32(fnv1a("arena"))());
  });
});
