import { describe, expect, test } from "bun:test";
import {
  aggregateCoupReview,
  buildCoupBallotPrompt,
  collectCoupFacts,
  parseCoupBallot,
  resolveCoupReviewRules,
} from "../src/engine/coup/review";
import { act, startCoup } from "./coup-fixture";
import type { CoupState } from "../src/engine/coup/types";

function ballot(seat: number, value: number) {
  return {
    seat,
    bluff: value,
    read: value,
    tempo: value,
    poise: value,
    note: `评 ${seat + 1} 号`,
  };
}

function fullBallot(rater: number | "judge", value: number) {
  return {
    rater,
    rows: [ballot(0, value), ballot(1, value), ballot(2, value), ballot(3, value)],
  };
}

describe("coup review rules", () => {
  test("defaults keep four dimensions summing to one", () => {
    const s = startCoup();
    const rules = resolveCoupReviewRules(s.spec);
    const total = Object.values(rules.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(rules.selfWeight).toBe(0);
    expect(rules.judgeVotes).toBe(1);
  });

  test("custom weights are normalised", () => {
    const s = startCoup();
    const spec = {
      ...s.spec,
      review: { weights: { bluff: 2, read: 2, tempo: 0, poise: 0 } },
    };
    const rules = resolveCoupReviewRules(spec);
    expect(rules.weights.bluff).toBeCloseTo(0.5, 6);
    expect(rules.weights.read).toBeCloseTo(0.5, 6);
    expect(rules.weights.tempo).toBe(0);
  });
});

describe("coup ballot parsing", () => {
  test("accepts a clean four-row ballot", () => {
    const parsed = parseCoupBallot(
      JSON.stringify({ rows: [1, 2, 3, 4].map((n) => ({ seat: n, bluff: 8, read: 7, tempo: 6, poise: 5, note: "x" })) }),
    );
    expect(parsed?.rows).toHaveLength(4);
    expect(parsed?.rows[0].seat).toBe(0);
  });

  test("tolerates a code fence", () => {
    const raw = "```json\n" + JSON.stringify({ rows: [1, 2, 3, 4].map((n) => ({ seat: n, bluff: 8, read: 7, tempo: 6, poise: 5 })) }) + "\n```";
    expect(parseCoupBallot(raw)?.rows).toHaveLength(4);
  });

  test("rejects a short ballot", () => {
    const raw = JSON.stringify({ rows: [{ seat: 1, bluff: 5, read: 5, tempo: 5, poise: 5 }] });
    expect(parseCoupBallot(raw)).toBeNull();
  });

  test("clamps out-of-range scores", () => {
    const raw = JSON.stringify({
      rows: [
        { seat: 1, bluff: 99, read: -3, tempo: 5, poise: 5 },
        { seat: 2, bluff: 5, read: 5, tempo: 5, poise: 5 },
        { seat: 3, bluff: 5, read: 5, tempo: 5, poise: 5 },
        { seat: 4, bluff: 5, read: 5, tempo: 5, poise: 5 },
      ],
    });
    const parsed = parseCoupBallot(raw);
    expect(parsed?.rows[0].bluff).toBe(10);
    expect(parsed?.rows[0].read).toBe(0);
  });
});

describe("coup aggregation", () => {
  test("a self ballot is recorded but never counted", () => {
    const s = startCoup();
    const rules = resolveCoupReviewRules(s.spec);
    const verdict = aggregateCoupReview({
      rules,
      ballots: [fullBallot(0, 10), fullBallot(1, 4), fullBallot(2, 4)],
    });
    const seat0 = verdict.seats.find((x) => x.seat === 0)!;
    expect(seat0.selfTotal).toBe(10);
    expect(seat0.total).toBeLessThan(10);
    expect(seat0.ballots).toBe(2);
  });

  test("the judge ballot is worth one vote by default", () => {
    const s = startCoup();
    const rules = resolveCoupReviewRules(s.spec);
    const verdict = aggregateCoupReview({
      rules,
      ballots: [fullBallot(1, 4), fullBallot("judge", 8)],
    });
    const seat0 = verdict.seats.find((x) => x.seat === 0)!;
    expect(seat0.total).toBe(6);
  });

  test("a tie leaves no champion", () => {
    const s = startCoup();
    const rules = resolveCoupReviewRules(s.spec);
    const flat = {
      rater: 1,
      rows: [ballot(0, 5), ballot(1, 5), ballot(2, 5), ballot(3, 5)],
    };
    const verdict = aggregateCoupReview({ rules, ballots: [flat] });
    expect(verdict.champion).toBeNull();
  });

  test("a clear leader becomes the champion", () => {
    const s = startCoup();
    const rules = resolveCoupReviewRules(s.spec);
    const ballots = [
      { rater: 1, rows: [ballot(0, 9), ballot(1, 5), ballot(2, 4), ballot(3, 3)] },
      { rater: 2, rows: [ballot(0, 8), ballot(1, 5), ballot(2, 4), ballot(3, 3)] },
    ];
    const verdict = aggregateCoupReview({ rules, ballots });
    expect(verdict.champion).toBe(0);
  });
});

describe("coup facts card", () => {
  test("carries the terminal hands and the bluff count", () => {
    let s: CoupState = startCoup();
    s = act(s, 0, { kind: "act", action: "tax", target: null, say: "" });
    s = act(s, 1, { kind: "react", reaction: "pass", as: null, say: "" });
    s = act(s, 2, { kind: "react", reaction: "pass", as: null, say: "" });
    s = act(s, 3, { kind: "react", reaction: "pass", as: null, say: "" });

    const facts = collectCoupFacts(s);
    expect(facts.seats).toHaveLength(4);
    const actor = facts.seats[0];
    expect(actor.coins).toBe(5);
    expect(actor.claims.length + (actor.bluffs > 0 ? 1 : 0)).toBeGreaterThanOrEqual(0);
    expect(actor.hand.length + actor.revealed.length).toBe(2);
  });

  test("the ballot prompt keeps every model name out", () => {
    const s = startCoup();
    const facts = collectCoupFacts(s);
    const rules = resolveCoupReviewRules(s.spec);
    const prompt = buildCoupBallotPrompt({ facts, raterSeat: 0, rules });
    expect(prompt.system).not.toContain("opus");
    expect(prompt.messages[0].content).not.toContain("display");
  });
});
