import { describe, expect, test } from "bun:test";
import { BlueprintError, hashBlueprint, parseBlueprint, validateSubmission } from "../src/engine/blueprint";

const base = {
  id: "td-test",
  name: "测试局",
  tagline: "只用于测试",
  rounds: 3,
  briefing: "这是一段足够长的规则正文，用来满足最小学数限制，也让模型有东西可读。每轮同时提交一个数字和一个陈述。",
  submission: {
    slots: [
      { key: "bid", label: "报价", type: "number", required: true, reveal: "secret" },
      { key: "line", label: "陈述", type: "text", required: true, reveal: "public" },
    ],
  },
  rubric: {
    dimensions: [
      { key: "a", label: "甲", weight: 2, hint: "" },
      { key: "b", label: "乙", weight: 2, hint: "" },
    ],
  },
  victory: { type: "rubric_total", tiebreaker: "sudden_death", tieThreshold: 0.5 },
};

describe("blueprint validation", () => {
  test("normalises weights to sum to 1", () => {
    const bp = parseBlueprint(base);
    const sum = bp.rubric.dimensions.reduce((acc, d) => acc + d.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    expect(bp.rubric.dimensions[0].weight).toBeCloseTo(0.5, 4);
  });

  test("rejects duplicate slot keys", () => {
    const bad = {
      ...base,
      submission: { slots: [base.submission.slots[0], { ...base.submission.slots[1], key: "bid" }] },
    };
    expect(() => parseBlueprint(bad)).toThrow(BlueprintError);
  });

  test("rejects a choice slot with no options", () => {
    const bad = {
      ...base,
      submission: { slots: [{ key: "pick", label: "选", type: "choice", required: true, reveal: "public" }] },
    };
    expect(() => parseBlueprint(bad)).toThrow(/没有给选项/);
  });

  test("rejects too many rounds", () => {
    expect(() => parseBlueprint({ ...base, rounds: 99 })).toThrow(BlueprintError);
  });

  test("hash is stable and content-sensitive", () => {
    const a = hashBlueprint(parseBlueprint(base));
    const b = hashBlueprint(parseBlueprint(base));
    expect(a).toBe(b);
    const c = hashBlueprint(parseBlueprint({ ...base, rounds: 4 }));
    expect(c).not.toBe(a);
  });
});

describe("submission validation", () => {
  const bp = parseBlueprint(base);

  test("coerces numeric strings", () => {
    const r = validateSubmission(bp, { bid: "520 万", line: "我不急" });
    expect(r.ok).toBe(true);
    expect(r.content.bid).toBe(520);
  });

  test("flags a missing required slot", () => {
    const r = validateSubmission(bp, { line: "只有陈述" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("bid");
  });

  test("rejects a non-numeric bid", () => {
    const r = validateSubmission(bp, { bid: "很多", line: "x" });
    expect(r.ok).toBe(false);
  });
});
