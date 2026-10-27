import { describe, expect, test } from "bun:test";
import { act, cardCount, passAll, startCoup } from "./coup-fixture";
import type { CoupState, CoupRole } from "../src/engine/coup/types";

/** Force a seat's face-down hand. Ids stay unique; only the roles change. */
function setHand(state: CoupState, seat: number, roles: CoupRole[]): void {
  state.seats[seat].cards = roles.map((role, i) => ({
    id: state.seats[seat].cards[i]?.id ?? `x${seat}${i}`,
    role,
  }));
}

const pass = { kind: "react" as const, reaction: "pass" as const, as: null, say: "" };
const challenge = { kind: "react" as const, reaction: "challenge" as const, as: null, say: "" };

describe("challenges", () => {
  test("a successful challenge voids the action and the actor loses an influence", () => {
    let s = startCoup();
    setHand(s, 0, ["assassin", "captain"]); // no duke
    s = act(s, 0, { kind: "act", action: "tax", target: null, say: "" });
    s = act(s, 1, challenge);
    s = act(s, 2, pass);
    s = act(s, 3, pass);

    expect(s.phase).toBe("influence_lose");
    expect(s.queue).toEqual([0]);
    s = act(s, 0, { kind: "flip", index: 0 });

    expect(s.seats[0].revealed).toHaveLength(1);
    expect(s.seats[0].cards).toHaveLength(1);
    // The tax never happened.
    expect(s.seats[0].coins).toBe(2);
    expect(s.seats[0].stats.bluffs).toBe(1);
    expect(s.seats[1].stats.challenges).toBe(1);
    expect(cardCount(s)).toBe(15);
  });

  test("a failed challenge costs the challenger and the claim still resolves", () => {
    let s = startCoup();
    setHand(s, 0, ["duke", "contessa"]);
    s = act(s, 0, { kind: "act", action: "tax", target: null, say: "" });
    s = act(s, 1, challenge);
    s = act(s, 2, pass);
    s = act(s, 3, pass);

    expect(s.phase).toBe("influence_lose");
    expect(s.queue).toEqual([1]);
    s = act(s, 1, { kind: "flip", index: 0 });

    expect(s.seats[1].cards).toHaveLength(1);
    expect(s.seats[0].coins).toBe(5);
    // Prove returns the card to the deck and draws a replacement: hand size holds.
    expect(s.seats[0].cards).toHaveLength(2);
    expect(cardCount(s)).toBe(15);
  });

  test("only the first challenger clockwise counts", () => {
    let s = startCoup();
    setHand(s, 0, ["assassin", "captain"]);
    s = act(s, 0, { kind: "act", action: "tax", target: null, say: "" });
    s = act(s, 1, pass);
    s = act(s, 2, challenge);
    s = act(s, 3, challenge);

    expect(s.phase).toBe("influence_lose");
    // Seat 0 lost the challenge; seats 2 and 3 also spoke up but only 2 counts.
    expect(s.queue).toEqual([0]);
  });

  test("challenging a blocked action resolves the challenge before the block", () => {
    let s = startCoup();
    setHand(s, 0, ["assassin", "duke"]);
    setHand(s, 1, ["contessa", "captain"]);
    s.seats[0].coins = 3;
    s = act(s, 0, { kind: "act", action: "assassinate", target: 1, say: "" });
    // Seat 1 both blocks and is the target; seat 0's assassin claim is challenged by 2.
    s = act(s, 1, { kind: "react", reaction: "block", as: "contessa", say: "" });
    s = act(s, 2, challenge);
    s = act(s, 3, pass);

    // The assassin claim holds: seat 2 loses one influence.
    expect(s.phase).toBe("influence_lose");
    expect(s.queue).toEqual([2]);
    s = act(s, 2, { kind: "flip", index: 0 });

    // Only now does the block get challenged; nobody does, so the hit is blocked.
    expect(s.phase).toBe("block_reaction");
    s = passAll(s);
    expect(s.seats[1].cards).toHaveLength(2);
    expect(s.seats[0].coins).toBe(0);
  });
});

describe("blocks", () => {
  test("a blocked assassination keeps the fee", () => {
    let s = startCoup();
    setHand(s, 0, ["assassin", "duke"]);
    setHand(s, 1, ["contessa", "captain"]);
    s.seats[0].coins = 3;

    s = act(s, 0, { kind: "act", action: "assassinate", target: 1, say: "" });
    expect(s.seats[0].coins).toBe(0); // paid on the claim

    s = act(s, 1, { kind: "react", reaction: "block", as: "contessa", say: "" });
    s = act(s, 2, pass);
    s = act(s, 3, pass);
    expect(s.phase).toBe("block_reaction");

    s = passAll(s);
    expect(s.seats[0].coins).toBe(0); // not refunded
    expect(s.seats[1].cards).toHaveLength(2);
  });

  test("a challenged false block removes the blocker's influence and the hit lands", () => {
    let s = startCoup();
    setHand(s, 0, ["assassin", "duke"]);
    setHand(s, 1, ["captain", "ambassador"]); // no contessa
    s.seats[0].coins = 3;

    s = act(s, 0, { kind: "act", action: "assassinate", target: 1, say: "" });
    s = act(s, 1, { kind: "react", reaction: "block", as: "contessa", say: "" });
    s = act(s, 2, pass);
    s = act(s, 3, pass);
    expect(s.phase).toBe("block_reaction");

    // Seat 0 challenges the block.
    s = act(s, 0, challenge);
    s = act(s, 2, pass);
    s = act(s, 3, pass);

    // Blocker loses one; the assassination then resolves on the same seat.
    expect(s.phase).toBe("influence_lose");
    expect(s.queue).toEqual([1]);
    s = act(s, 1, { kind: "flip", index: 0 });
    // Double jeopardy: the block failure and the assassination each cost a life.
    expect(s.seats[1].cards).toHaveLength(0);
    expect(s.seats[1].alive).toBe(false);
  });

  test("foreign aid can be blocked by anyone with the duke", () => {
    let s = startCoup();
    setHand(s, 2, ["duke", "captain"]);
    s = act(s, 0, { kind: "act", action: "foreign_aid", target: null, say: "" });
    s = act(s, 1, pass);
    s = act(s, 2, { kind: "react", reaction: "block", as: "duke", say: "" });
    s = act(s, 3, pass);

    expect(s.phase).toBe("block_reaction");
    s = passAll(s);
    expect(s.seats[0].coins).toBe(2);
  });

  test("only the steal target may block", () => {
    let s = startCoup();
    setHand(s, 2, ["captain", "duke"]);
    s.seats[1].coins = 5;
    s = act(s, 0, { kind: "act", action: "steal", target: 1, say: "" });
    // Seat 2 is not the target; its block is illegal and degrades to a pass.
    s = act(s, 2, { kind: "react", reaction: "block", as: "captain", say: "" });
    s = act(s, 1, pass);
    s = act(s, 3, pass);

    expect(s.phase).toBe("action_select");
    expect(s.seats[0].coins).toBe(4);
  });
});
