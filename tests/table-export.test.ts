import { describe, expect, test } from "bun:test";
import type { ArenaEvent } from "../src/engine/types";
import { tableFromRoster as tableFromRosterForTest } from "../src/lib/werewolf-frame";
import {
  buildExportHtml,
  compactEvents,
  escapeInlineScript,
  escapeJsonForScript,
  exportFileName,
  sanitizeFilePart,
  type TableExportMatch,
} from "../src/lib/table-export";

function event(seq: number, type: ArenaEvent["type"], payload: Record<string, unknown>): ArenaEvent {
  return { seq, type, ts: 1_700_000_000_000 + seq, payload };
}

const MATCH: TableExportMatch = {
  id: "m_test",
  status: "finished",
  rulesetName: "预女猎九人局",
  seed: "seed-42",
  createdAt: 1_700_000_000_000,
  finishedAt: 1_700_000_360_000,
};

describe("compactEvents", () => {
  test("drops the streaming tail and keeps every fact in order", () => {
    const events = [
      event(1, "match.created", { name: "测试局", seats: [] }),
      event(2, "seat.thinking.delta", { seat: 0, delta: "想", channel: "note" }),
      event(3, "judge.thinking.delta", { delta: "裁" }),
      event(4, "state.snapshot", { state: { huge: true } }),
      event(5, "seat.submitted", { seat: 0, thinking: "为什么", reasoning: "原生推理" }),
      event(6, "review.verdict", { attempt: 1, ranking: [] }),
      event(7, "review.thinking.delta", { attempt: 1, rater: 0, channel: "reason", delta: "想" }),
    ];
    const out = compactEvents(events);
    expect(out.map((e) => e.seq)).toEqual([1, 5, 6]);
    expect(out[2].payload).toEqual({ attempt: 1, ranking: [] });
  });

  test("reasoning:false strips only the native channel", () => {
    const events = [
      event(1, "seat.submitted", { seat: 0, thinking: "观众可见", reasoning: "很长很长" }),
      event(2, "seat.submitted", { seat: 1, thinking: "无推理" }),
    ];
    const out = compactEvents(events, { reasoning: false });
    expect(out[0].payload).toEqual({ seat: 0, thinking: "观众可见" });
    expect(out[1].payload).toEqual({ seat: 1, thinking: "无推理" });
  });

  test("does not mutate the source payloads", () => {
    const payload = { seat: 0, thinking: "note", reasoning: "native" };
    const events = [event(1, "seat.submitted", payload)];
    compactEvents(events, { reasoning: false });
    expect(payload).toEqual({ seat: 0, thinking: "note", reasoning: "native" });
  });
});

describe("escaping", () => {
  test("json escapes the tag opener, not the payload text", () => {
    const out = escapeJsonForScript('{"text":"</script><b>"}');
    expect(out).toBe('{"text":"\\u003c/script>\\u003cb>"}');
    expect(JSON.parse(out)).toEqual({ text: "</script><b>" });
  });

  test("inline js cannot terminate its own script tag", () => {
    expect(escapeInlineScript('const x = "</script>";')).toBe('const x = "<\\/script>";');
  });
});

describe("buildExportHtml", () => {
  test("emits a self-contained document with the data and runtime", () => {
    const html = buildExportHtml({
      title: "斗场 · 测试局",
      css: ":root{--ink-0:#08080a}",
      js: "console.log('replay')",
      data: '{"v":1}',
      encoding: "json",
      themeBoot: "(function(){})();",
      note: "match m_test",
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="zh-CN" data-theme="dark" data-mode="auto">');
    expect(html).toContain('<style>\n:root{--ink-0:#08080a}\n</style>');
    expect(html).toContain('id="arena-export-data" data-encoding="json"');
    expect(html).toContain("console.log('replay')");
    expect(html).toContain("<!-- match m_test -->");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  test("refuses css that would close the style block", () => {
    expect(() =>
      buildExportHtml({
        title: "x",
        css: "body{content:'</style><script>alert(1)</script>'}",
        js: "",
        data: "{}",
        encoding: "json",
        themeBoot: "",
      }),
    ).toThrow();
  });

  test("escapes a title that looks like markup", () => {
    const html = buildExportHtml({
      title: "</title><script>alert(1)</script>",
      css: "",
      js: "",
      data: "{}",
      encoding: "json",
      themeBoot: "",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;");
  });
});

describe("file names", () => {
  test("drops path and header separators", () => {
    expect(sanitizeFilePart('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(sanitizeFilePart("   ")).toBe("match");
    expect(sanitizeFilePart("x".repeat(200)).length).toBe(64);
  });

  test("keeps the ruleset, seed and a sortable stamp", () => {
    const name = exportFileName(MATCH);
    expect(name).toStartWith("斗场-预女猎九人局-seed-42-");
    expect(name).toEndWith(".html");
    expect(name).not.toContain("/");
  });
});

describe("foldTableView", () => {
  test("the snapshot path is byte-for-byte the live reducer path", async () => {
    const { applyWerewolfEvent, foldTableView } = await import("../src/components/WerewolfTable");
    const events = [
      event(1, "match.created", {
        name: "测试局",
        tagline: "一句话",
        maxDays: 2,
        briefing: "规则",
        seats: [{ seat: 0, participantId: "p0" }],
      }),
      event(2, "roles.dealt", { seats: [{ seat: 0, role: "wolf", camp: "wolf" }] }),
      event(3, "seat.submitted", {
        seat: 0,
        phase: "night_wolves",
        thinking: "观众可见",
        reasoning: "原生推理",
        content: { kind: "kill", target: 4 },
      }),
      event(4, "match.finished", { winnerCamp: "wolf", winnerName: "狼人阵营", reason: "wolves_out" }),
    ];
    let manual = tableFromRosterForTest([]);
    for (const e of events) manual = applyWerewolfEvent(manual, e);
    const folded = foldTableView({
      participants: [],
      events,
      status: "finished",
      live: false,
      judgeDisplay: "裁判模型",
    });
    expect(folded).toEqual({
      ...manual,
      status: "finished",
      live: false,
      judgeName: "裁判模型",
    });
  });
});
