import { describe, expect, test } from "bun:test";
import { buildDeck, dealCards, holds } from "../src/engine/coup/deal";
import { COUP_ROLES } from "../src/engine/coup/types";

describe("coup deck", () => {
  test("fifteen cards, three copies of each role", () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(15);
    for (const role of COUP_ROLES) {
      expect(deck.filter((c) => c.role === role)).toHaveLength(3);
    }
  });

  test("deals two to each of four seats and leaves seven", () => {
    const { hands, deck } = dealCards("seed-a", 4);
    expect(hands).toHaveLength(4);
    for (const hand of hands) expect(hand).toHaveLength(2);
    expect(deck).toHaveLength(7);
    expect(hands.flat().length + deck.length).toBe(15);
  });

  test("same seed produces the same deal", () => {
    const a = dealCards("seed-a", 4);
    const b = dealCards("seed-a", 4);
    expect(a).toEqual(b);
  });

  test("different seeds produce different deals", () => {
    const a = dealCards("seed-a", 4);
    const b = dealCards("seed-b", 4);
    expect(a).not.toEqual(b);
  });

  test("card ids are unique", () => {
    const { hands, deck } = dealCards("seed-c", 4);
    const ids = [...hands.flat(), ...deck].map((c) => c.id);
    expect(new Set(ids).size).toBe(15);
  });

  test("six seats still leave three cards", () => {
    const { hands, deck } = dealCards("seed-d", 6);
    expect(hands).toHaveLength(6);
    expect(hands.flat()).toHaveLength(12);
    expect(deck).toHaveLength(3);
  });

  test("holds only sees face-down copies", () => {
    expect(holds([{ id: "c1", role: "duke" }], "duke")).toBe(true);
    expect(holds([{ id: "c1", role: "duke" }], "captain")).toBe(false);
    expect(holds([], "duke")).toBe(false);
    expect(holds([{ id: "c1", role: "duke" }], null)).toBe(false);
  });
});
