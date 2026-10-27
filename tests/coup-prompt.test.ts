import { describe, expect, test } from "bun:test";
import { act, passAll, startCoup } from "./coup-fixture";
import { buildSeatPrompt, renderChronicle } from "../src/engine/coup/prompt";
import type { CoupRole } from "../src/engine/coup/types";

describe("coup prompt", () => {
  test("the system string is byte-identical for all four seats", () => {
    const s = startCoup();
    const systems = s.seats.map((seat) => buildSeatPrompt({ state: s, seat: seat.seat }).system);
    for (const system of systems) expect(system).toBe(systems[0]);
  });

  test("the system never mentions a seat number or a hand", () => {
    const s = startCoup();
    const { system } = buildSeatPrompt({ state: s, seat: 0 });
    expect(system).not.toMatch(/[1-4]\s*号/);
    // The bluff licence has to be there, or models play an honest game.
    expect(system).toContain("诈唬是本游戏");
  });

  test("a seat can see its own hand but not anyone else's", () => {
    const s = startCoup();
    const self = s.seats[0];
    const other = s.seats[1];
    const prompt = buildSeatPrompt({ state: s, seat: 0 });
    const user = prompt.messages[0].content;

    for (const card of self.cards) {
      expect(user).toContain(labelOf(s, card.role));
    }
    // A role only the opponent holds must not leak through the "your hand" block.
    const mine = new Set(self.cards.map((c) => c.role));
    for (const card of other.cards) {
      if (mine.has(card.role)) continue;
      // It may appear in the rules list, but never as a hand entry.
      expect(user).not.toContain(`  ${card.id}`);
    }
  });

  test("cacheAt marks the end of the chronicle", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "income", target: null, say: "" });
    const prompt = buildSeatPrompt({ state: s, seat: 1 });
    const chronicle = renderChronicle(s);
    const head = `## 公开编年史\n${chronicle}`;
    expect(prompt.messages[0].cacheAt).toBe(head.length);
    expect(prompt.messages[0].content.slice(0, head.length)).toBe(head);
  });

  test("the chronicle only grows: next round starts with the previous text", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "income", target: null, say: "" });
    const first = renderChronicle(s);
    s = act(s, 1, { kind: "act", action: "income", target: null, say: "" });
    const second = renderChronicle(s);
    expect(second.startsWith(first)).toBe(true);
  });

  test("a reaction prompt names the claimant and the legal choices", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "tax", target: null, say: "我当然是公爵。" });
    const prompt = buildSeatPrompt({ state: s, seat: 1 });
    const user = prompt.messages[0].content;
    expect(user).toContain("1 号宣称");
    expect(user).toContain("pass");
    expect(user).toContain("challenge");
  });

  test("a steal prompt only offers block to the target", () => {
    let s = startCoup();
    s = act(s, 0, { kind: "act", action: "steal", target: 2, say: "" });
    const target = buildSeatPrompt({ state: s, seat: 2 }).messages[0].content;
    const bystander = buildSeatPrompt({ state: s, seat: 3 }).messages[0].content;
    expect(target).toContain("block");
    expect(bystander).not.toContain("block（");
  });
});

function labelOf(state: ReturnType<typeof startCoup>, role: CoupRole): string {
  return state.spec.roles.find((r) => r.id === role)?.label ?? role;
}
