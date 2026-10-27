import { describe, expect, test } from "bun:test";
import { buildCommentaryPrompt, parseCommentary } from "../src/engine/coup/commentary";
import { emptyTurn, type CoupTurnRecord } from "../src/engine/coup/turn";
import { startCoup } from "./coup-fixture";

function record(overrides: Partial<CoupTurnRecord> = {}): CoupTurnRecord {
  return {
    ...emptyTurn(3),
    seq: 42,
    actor: 2,
    action: "steal",
    role: "captain",
    target: 1,
    say: "借你两枚。",
    note: "我手上没有队长，赌他们不敢质疑。",
    honest: false,
    paid: 0,
    challengeable: true,
    blockable: true,
    reactions: [
      { seat: 0, kind: "pass", as: null, say: "先看看", note: "", forfeit: false, anomalies: [], about: "claim" },
      { seat: 1, kind: "challenge", as: null, say: "你没有队长", note: "他前两手都没用过队长。", forfeit: false, anomalies: [], about: "claim" },
      { seat: 3, kind: "pass", as: null, say: "", note: "", forfeit: false, anomalies: [], about: "claim" },
    ],
    challenge: { challenger: 1, target: 2, holds: false, role: "captain" },
    lost: [{ seat: 2, role: "assassin", cause: "challenge_failed", remaining: 1 }],
    coins: [{ seat: 2, coins: 2, before: 5 }],
    ...overrides,
  };
}

describe("commentary prompt", () => {
  test("the system states the three beats and the length limit", () => {
    const prompt = buildCommentaryPrompt({ state: startCoup(), turn: record(), finished: false });
    expect(prompt.system).toContain("160 字");
    expect(prompt.system).toContain("诈唬");
    expect(prompt.system).toContain('{"text"');
    expect(prompt.system).toContain("不可信的对局文本");
  });

  test("every reaction's own words make it into the prompt", () => {
    const prompt = buildCommentaryPrompt({ state: startCoup(), turn: record(), finished: false });
    const user = prompt.messages[0]!.content;
    expect(user).toContain("先看看");
    expect(user).toContain("你没有队长");
    expect(user).toContain("他前两手都没用过队长");
    // The audience-facing truth must be explicit, not left to the model's guess.
    expect(user).toContain("诈唬");
    expect(user).toContain("质疑成立");
    expect(user).toContain("3 号 5 → 2 枚");
  });

  test("a finished match asks for a closing summary", () => {
    const prompt = buildCommentaryPrompt({ state: startCoup(), turn: record(), finished: true });
    expect(prompt.messages[0]!.content).toContain("牌局刚刚结束");
  });

  test("model names never appear: the narrator only sees seats", () => {
    const state = startCoup();
    const prompt = buildCommentaryPrompt({ state, turn: record(), finished: false });
    const user = prompt.messages[0]!.content;
    expect(user).not.toContain("DeepSeek");
    expect(user).not.toContain("GLM");
    expect(user).not.toContain("Seed");
  });

  test("the cache breakpoint ends the chronicle, so the prefix only grows", () => {
    const prompt = buildCommentaryPrompt({ state: startCoup(), turn: record(), finished: false });
    const message = prompt.messages[0]!;
    const at = message.cacheAt ?? -1;
    expect(at).toBeGreaterThan(0);
    expect(message.content.slice(0, at).startsWith("## 公开编年史")).toBe(true);
    expect(message.content.slice(at)).toContain("## 全部手牌");
  });

  test("a table with no reaction says so instead of inventing one", () => {
    const prompt = buildCommentaryPrompt({
      state: startCoup(),
      turn: record({ reactions: [] }),
      finished: false,
    });
    expect(prompt.messages[0]!.content).toContain("没有人表态");
  });
});

describe("commentary parsing", () => {
  test("reads the JSON field, fences and all", () => {
    expect(parseCommentary('```json\n{"text":"3 号在诈唬。\\n2 号没接。"}\n```')).toBe("3 号在诈唬。\n2 号没接。");
  });

  test("falls back to plain text", () => {
    expect(parseCommentary("3 号在诈唬。")).toBe("3 号在诈唬。");
  });

  test("clamps to 160 characters and keeps the ellipsis", () => {
    const long = "甲".repeat(200);
    const out = parseCommentary(long)!;
    expect(out.length).toBe(160);
    expect(out.endsWith("…")).toBe(true);
  });

  test("an empty answer is null, never an empty bubble", () => {
    expect(parseCommentary("   ")).toBeNull();
    expect(parseCommentary('{"text":"   "}')).toBeNull();
  });
});
