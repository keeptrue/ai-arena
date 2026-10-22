import { describe, expect, test } from "bun:test";
import { chooseJudge, type JudgeCandidate } from "../src/engine/judge";

const A: JudgeCandidate = { id: "m-a", providerId: "vendor-x", display: "甲" };
const B: JudgeCandidate = { id: "m-b", providerId: "vendor-y", display: "乙" };
const C: JudgeCandidate = { id: "m-c", providerId: "vendor-x", display: "丙" };

describe("judge selection", () => {
  test("an explicit pick wins even when a more independent model exists", () => {
    // A shares a vendor with the roster, B does not — the user still asked for A.
    const pick = chooseJudge([A, B], ["vendor-x"], "m-a");
    expect(pick).toEqual({ ok: true, modelId: "m-a", reason: "explicit" });
  });

  test("an explicit pick that is not in the pool is rejected, not ignored", () => {
    expect(chooseJudge([A, B], [], "m-z")).toEqual({ ok: false, reason: "not_in_pool" });
  });

  test("preferred ids are trimmed", () => {
    expect(chooseJudge([A, B], [], "  m-b  ")).toEqual({
      ok: true,
      modelId: "m-b",
      reason: "explicit",
    });
  });

  test("auto prefers a provider that is not on the roster", () => {
    const pick = chooseJudge([A, B, C], ["vendor-x"]);
    expect(pick).toEqual({ ok: true, modelId: "m-b", reason: "independent" });
  });

  test("auto keeps candidate order among independent providers", () => {
    const pick = chooseJudge([B, A], ["vendor-x"]);
    expect(pick).toEqual({ ok: true, modelId: "m-b", reason: "independent" });
  });

  test("auto falls back to the first candidate when every vendor is on the roster", () => {
    const pick = chooseJudge([A, B, C], ["vendor-x", "vendor-y"]);
    expect(pick).toEqual({ ok: true, modelId: "m-a", reason: "fallback" });
  });

  test("an empty pool cannot name a judge", () => {
    expect(chooseJudge([], ["vendor-x"])).toEqual({ ok: false, reason: "empty_pool" });
    expect(chooseJudge([], [], "m-a")).toEqual({ ok: false, reason: "not_in_pool" });
    expect(chooseJudge([], [])).toEqual({ ok: false, reason: "empty_pool" });
  });

  test("a blank preferred id means auto", () => {
    expect(chooseJudge([A, B], ["vendor-x"], "   ")).toEqual({
      ok: true,
      modelId: "m-b",
      reason: "independent",
    });
  });
});
