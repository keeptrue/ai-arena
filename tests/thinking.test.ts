import { describe, expect, test } from "bun:test";
import { PROMPT_SLOTS } from "../src/engine/prompt-templates";
import {
  LIVE_TAIL_CHARS,
  splitBlocks,
  splitThinking,
  tailWindowStart,
  THINKING_LIMIT,
} from "../src/lib/thinking";

describe("splitThinking", () => {
  test("keeps short notes whole", () => {
    expect(splitThinking("他上一轮连出两手布。", 500)).toEqual({
      head: "他上一轮连出两手布。",
      rest: "",
      over: false,
    });
  });

  test("500 exactly is still whole", () => {
    const text = "字".repeat(THINKING_LIMIT);
    const parts = splitThinking(text);
    expect(parts.over).toBe(false);
    expect(parts.head).toHaveLength(THINKING_LIMIT);
    expect(parts.rest).toBe("");
  });

  test("501 splits at the limit and reports the rest", () => {
    const text = " 字".repeat(0) + "字".repeat(THINKING_LIMIT + 1);
    const parts = splitThinking(text);
    expect(parts.over).toBe(true);
    expect(parts.head).toHaveLength(THINKING_LIMIT);
    expect(parts.rest).toHaveLength(1);
    expect(parts.head + parts.rest).toBe(text);
  });

  test("counts CJK by character, not by byte", () => {
    const text = "为什么这么选。".repeat(100);
    const parts = splitThinking(text, 10);
    expect(parts.head).toBe("为什么这么选。为什么");
    expect(parts.over).toBe(true);
  });

  test("empty text never folds", () => {
    expect(splitThinking("")).toEqual({ head: "", rest: "", over: false });
  });

  test("a degenerate limit hides everything but keeps the text", () => {
    const parts = splitThinking("abc", 0);
    expect(parts.head).toBe("");
    expect(parts.rest).toBe("abc");
    expect(parts.over).toBe(true);
  });
});

describe("audience thinking prompt", () => {
  const body = PROMPT_SLOTS["participant.system"].defaultBody;

  test("asks for a 500-character note aimed at the audience", () => {
    expect(body).toContain("500 字以内");
    expect(body).toContain("为什么这么选");
    expect(body).toContain("对手与裁判都看不到");
    expect(body).not.toContain("200 字");
  });
});

describe("live tail window", () => {
  test("short streams are shown whole", () => {
    const chunks = ["我要", "说两句"];
    expect(tailWindowStart(chunks, 500)).toBe(0);
  });

  test("long streams keep only the tail, and the boundary chunk stays", () => {
    const chunks = Array.from({ length: 100 }, () => "字".repeat(60)); // 6 000 chars
    const start = tailWindowStart(chunks, 1_000);
    expect(start).toBeGreaterThan(0);
    const shown = chunks.slice(start).join("");
    expect(shown.length).toBeGreaterThan(1_000 - 60);
    expect(shown.length).toBeLessThanOrEqual(1_000);
  });

  test("an oversized single chunk is never truncated", () => {
    const chunks = ["前文", "字".repeat(LIVE_TAIL_CHARS * 2)];
    const start = tailWindowStart(chunks, 100);
    expect(chunks.slice(start).join("")).toBe(chunks[1]);
  });

  test("a degenerate limit renders nothing to trim", () => {
    expect(tailWindowStart(["a", "b"], 0)).toBe(2);
  });
});

describe("splitBlocks", () => {
  test("keeps line structure so pre-wrap spacing survives", () => {
    expect(splitBlocks("一\n\n二")).toEqual(["一", "", "二"]);
  });

  test("empty text yields no blocks", () => {
    expect(splitBlocks("")).toEqual([]);
  });
});
