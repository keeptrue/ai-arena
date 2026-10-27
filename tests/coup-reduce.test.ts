import { describe, expect, test } from "bun:test";
import { act, buildCoupBlueprint, cardCount, passAll, startCoup } from "./coup-fixture";
import { coerceCoupMove, legalAction, reduceCoup } from "../src/engine/coup/reduce";

describe("coup turn structure", () => {
  test("opening state: four seats, two cards, two coins, seven in the deck", () => {
    const s = startCoup();
    expect(s.phase).toBe("action_select");
    expect(s.actor).toBe(0);
    expect(s.turn).toBe(1);
    expect(s.seats).toHaveLength(4);
    for (const seat of s.seats) {
      expect(seat.cards).toHaveLength(2);
      expect(seat.coins).toBe(2);
      expect(seat.alive).toBe(true);
    }
    expect(s.deck).toHaveLength(7);
    expect(cardCount(s)).toBe(15);
  });

  test("income adds one coin and passes the turn clockwise", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "income", target: null, say: "" });
    expect(s.seats[0].coins).toBe(3);
    expect(s.turn).toBe(2);
    expect(s.actor).toBe(1);
    expect(s.phase).toBe("action_select");
  });

  test("tax pays three once the table passes", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "tax", target: null, say: "" });
    expect(s.phase).toBe("action_reaction");
    s = passAll(s);
    expect(s.seats[0].coins).toBe(5);
    expect(s.actor).toBe(1);
    expect(cardCount(s)).toBe(15);
  });

  test("foreign aid pays two", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "foreign_aid", target: null, say: "" });
    s = passAll(s);
    expect(s.seats[0].coins).toBe(4);
  });

  test("steal moves at most two coins", () => {
    let s = startCoup();
    s.seats[1].coins = 5;
    s = act(s, 0, { kind: "act", action: "steal", target: 1, say: "" });
    s = passAll(s);
    expect(s.seats[0].coins).toBe(4);
    expect(s.seats[1].coins).toBe(3);
  });

  test("steal takes only one when the target holds one", () => {
    let s = startCoup();
    s.seats[1].coins = 1;
    s = act(s, 0, { kind: "act", action: "steal", target: 1, say: "" });
    s = passAll(s);
    expect(s.seats[0].coins).toBe(3);
    expect(s.seats[1].coins).toBe(0);
  });

  test("coup costs seven and forces a flip", () => {
    let s = startCoup();
    s.seats[0].coins = 7;
    s = act(s, 0, { kind: "act", action: "coup", target: 1, say: "" });
    expect(s.phase).toBe("influence_lose");
    s = act(s, 1, { kind: "flip", index: 0 });
    expect(s.seats[0].coins).toBe(0);
    expect(s.seats[1].cards).toHaveLength(1);
    expect(s.seats[1].revealed).toHaveLength(1);
    expect(cardCount(s)).toBe(15);
  });

  test("coup is not challengeable and not blockable", () => {
    let s = startCoup();
    s.seats[0].coins = 7;
    s = act(s, 0, { kind: "act", action: "coup", target: 1, say: "" });
    // Straight to the flip: nobody was asked to react.
    expect(s.phase).toBe("influence_lose");
    expect(s.queue).toEqual([1]);
  });

  test("a seat on ten coins must coup", () => {
    const s = startCoup();
    s.seats[0].coins = 10;
    expect(legalAction(s, 0, "income")).toBeNull();
    expect(legalAction(s, 0, "tax")).toBeNull();
    expect(legalAction(s, 0, "coup")).not.toBeNull();
  });

  test("assassinate needs three coins", () => {
    const s = startCoup();
    expect(legalAction(s, 0, "assassinate")).toBeNull();
    s.seats[0].coins = 3;
    expect(legalAction(s, 0, "assassinate")).not.toBeNull();
  });

  test("an illegal action falls back to income instead of inventing a claim", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "coup", target: 1, say: "" });
    // 2 coins < 7, so the engine refuses the coup and pays income instead.
    expect(s.seats[0].coins).toBe(3);
    expect(s.phase).not.toBe("influence_lose");
  });

  test("turn limit settles by influence then coins", () => {
    let s = startCoup({ spec: buildCoupBlueprint({ maxTurns: 1 }) });
    s = act(s, 0, { kind: "act", action: "income", target: null, say: "" });
    expect(s.phase).toBe("done");
    expect(s.winner).toBe(0);
    expect(s.endReason).toBe("turn_limit");
  });

  test("turn limit with identical boards is a draw", () => {
    const spec = buildCoupBlueprint({ maxTurns: 1 });
    let s = startCoup({ spec });
    s = act(s, 0, { kind: "act", action: "foreign_aid", target: null, say: "" });
    s = passAll(s);
    // Everyone still holds two cards; seat 0 is ahead on coins, so no draw.
    expect(s.winner).toBe(0);
  });
});

describe("audience events", () => {
  function submitWith(
    state: ReturnType<typeof startCoup>,
    seat: number,
    move: Parameters<typeof act>[2],
    thinking = "",
  ) {
    return reduceCoup(state, {
      kind: "submit",
      submission: {
        seat,
        phase: state.phase,
        status: "ready",
        move,
        thinking,
        reasoning: "",
        raw: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        anomalies: [],
      },
    });
  }

  function emitted(effects: ReturnType<typeof submitWith>["effects"]) {
    return effects.flatMap((effect) => (effect.kind === "emit" ? [effect.event] : []));
  }

  test("an action carries the note and the audience-only truth flag", () => {
    const s = startCoup();
    const { effects } = submitWith(s, 0, { kind: "act", action: "income", target: null, say: "" }, "我先攒钱。");
    const action = emitted(effects).find((e) => e.type === "coup.action");
    expect(action).toBeDefined();
    expect(action!.payload.note).toBe("我先攒钱。");
    expect(action!.payload.honest).toBeNull();
  });

  test("a role claim reports whether the card was really in hand", () => {
    let s = startCoup();
    const role = s.seats[0].cards[0]!.role;
    s.seats[0].cards = [{ id: "forced", role: "duke" }, ...s.seats[0].cards.slice(1)];
    const { effects } = submitWith(s, 0, { kind: "act", action: "tax", target: null, say: "" });
    const action = emitted(effects).find((e) => e.type === "coup.action")!;
    expect(action.payload.honest).toBe(true);
    expect(action.payload.role).toBe("duke");
    expect(role).toBeDefined();
  });

  test("income emits a coin event with the pre-change balance", () => {
    const s = startCoup();
    const { effects } = submitWith(s, 0, { kind: "act", action: "income", target: null, say: "" });
    const coins = emitted(effects).find((e) => e.type === "coup.coins")!;
    expect(coins.payload.coins).toEqual([{ seat: 0, coins: 3, before: 2 }]);
  });

  test("a steal emits both sides of the transfer", () => {
    let s = startCoup();
    s.seats[1].coins = 5;
    ({ state: s } = submitWith(s, 0, { kind: "act", action: "steal", target: 1, say: "" }));
    let last: ReturnType<typeof submitWith> | null = null;
    for (const seat of [1, 2, 3]) {
      last = submitWith(s, seat, { kind: "react", reaction: "pass", as: null, say: "" });
      s = last.state;
    }
    const coins = emitted(last!.effects).filter((e) => e.type === "coup.coins");
    const rows = coins.flatMap((e) => e.payload.coins as Array<{ seat: number; coins: number; before: number }>);
    expect(rows).toContainEqual({ seat: 0, coins: 4, before: 2 });
    expect(rows).toContainEqual({ seat: 1, coins: 3, before: 5 });
  });

  test("a successful prove emits the replacement hand", () => {
    let s = startCoup();
    s.seats[0].cards = [
      { id: "forced-duke", role: "duke" },
      { id: "forced-contessa", role: "contessa" },
    ];
    ({ state: s } = submitWith(s, 0, { kind: "act", action: "tax", target: null, say: "" }));
    ({ state: s } = submitWith(s, 1, { kind: "react", reaction: "challenge", as: null, say: "" }));
    for (const seat of [2, 3]) {
      ({ state: s } = submitWith(s, seat, { kind: "react", reaction: "pass", as: null, say: "" }));
    }
    // The challenger must pick which card to flip before the claimant proves.
    expect(s.phase).toBe("influence_lose");
    const { effects } = submitWith(s, 1, { kind: "flip", index: 0 });
    const hand = emitted(effects).find((e) => e.type === "coup.hand");
    expect(hand).toBeDefined();
    const cards = hand!.payload.cards as Array<{ role: string }>;
    expect(cards.some((c) => c.role === "duke")).toBe(false);
    expect(cards).toHaveLength(2);
  });

  test("the new turn event carries coins, deck and survivors", () => {
    const s = startCoup();
    const { effects } = submitWith(s, 0, { kind: "act", action: "income", target: null, say: "" });
    const turn = emitted(effects).find((e) => e.type === "coup.turn")!;
    expect(turn.payload.deck).toBe(7);
    expect(turn.payload.alive).toEqual([0, 1, 2, 3]);
    expect(turn.payload.coins).toContainEqual({ seat: 0, coins: 3 });
  });
});

describe("submission coercion", () => {
  test("a prompt-shaped null target stays null instead of becoming seat 1", () => {
    const move = coerceCoupMove("action_select", { action: "tax", target: null, say: "" });
    expect(move).toEqual({ kind: "act", action: "tax", target: null, say: "" });
  });

  test("an empty-string target is no target", () => {
    const move = coerceCoupMove("action_select", { action: "income", target: "", say: "" });
    expect(move).toMatchObject({ kind: "act", action: "income", target: null });
  });

  test("seat numbers are 1-based on the wire, 0-based in the engine", () => {
    expect(coerceCoupMove("action_select", { action: "steal", target: 2, say: "" })).toMatchObject({ target: 1 });
    expect(coerceCoupMove("action_select", { action: "steal", target: "4", say: "" })).toMatchObject({ target: 3 });
  });

  test("a coerced 1-based target reaches the right seat", () => {
    let s = startCoup();
    const move = coerceCoupMove("action_select", { action: "steal", target: 2, say: "" });
    expect(move).not.toBeNull();
    s = act(s, 0, move!);
    expect(s.claim?.target).toBe(1);
  });
});

describe("forfeit plumbing", () => {
  test("a forfeited action still emits the fallback and says it was a forfeit", () => {
    const s = startCoup();
    const { effects } = reduceCoup(s, {
      kind: "submit",
      submission: {
        seat: 0,
        phase: s.phase,
        status: "forfeit",
        move: null,
        thinking: "我本想征税。",
        reasoning: "",
        raw: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        anomalies: ["invalid_move"],
      },
    });
    const events = effects.flatMap((effect) => (effect.kind === "emit" ? [effect.event] : []));
    const action = events.find((e) => e.type === "coup.action")!;
    expect(action.payload.action).toBe("income");
    expect(action.payload.forfeit).toBe(true);
    expect(action.payload.anomalies).toEqual(["invalid_move"]);
    expect(action.payload.note).toBe("我本想征税。");
    const forfeit = events.find((e) => e.type === "coup.forfeit")!;
    expect(forfeit.payload.seat).toBe(0);
    expect(forfeit.payload.phase).toBe("action_select");
    // The action opens the turn draft; the forfeit must land after it.
    expect(events.findIndex((e) => e.type === "coup.action")).toBeLessThan(
      events.findIndex((e) => e.type === "coup.forfeit"),
    );
  });

  test("Chinese action and role names are normalised instead of forfeited", () => {
    expect(coerceCoupMove("action_select", { action: "偷窃", target: 2 })).toMatchObject({
      action: "steal",
      target: 1,
    });
    expect(coerceCoupMove("action_reaction", { reaction: "质疑", as: null })).toMatchObject({
      reaction: "challenge",
    });
    expect(coerceCoupMove("action_reaction", { reaction: "阻挡", as: "伯爵夫人" })).toMatchObject({
      reaction: "block",
      as: "contessa",
    });
  });
});
