import { describe, expect, test } from "bun:test";
import { SubmissionStreamParser, parseSubmitPayload, repairJson } from "../src/engine/parse";

function streamChars(parser: SubmissionStreamParser, text: string): string {
  let thinking = "";
  for (const ch of text) thinking += parser.push(ch);
  return thinking;
}

describe("submission protocol", () => {
  test("full protocol streamed one character at a time", () => {
    const p = new SubmissionStreamParser();
    const raw = `<<<THINK>>>\n它上一轮报 520，话却说只出到 350。\n<<<SUBMIT>>>\n{"bid":480,"line":"我跟着走。"}`;
    const live = streamChars(p, raw);
    const fin = p.finish();
    expect(live).toContain("它上一轮报 520");
    expect(fin.thinking).toContain("它上一轮报 520");
    expect(fin.content).toEqual({ bid: 480, line: "我跟着走。" });
    expect(fin.anomalies).toEqual([]);
  });

  test("missing SUBMIT marker salvages trailing json", () => {
    const p = new SubmissionStreamParser();
    p.push(`<<<THINK>>>\n先不亮底。\n{"bid":300,"line":"我不急"}`);
    const fin = p.finish();
    expect(fin.content?.bid).toBe(300);
    expect(fin.anomalies).toContain("missing_submit_marker");
  });

  test("bare json without any marker still works", () => {
    const p = new SubmissionStreamParser();
    p.push(`{"bid": 610, "line": "加价"}`);
    const fin = p.finish();
    expect(fin.content).toEqual({ bid: 610, line: "加价" });
  });

  test("fenced json with trailing prose", () => {
    const p = new SubmissionStreamParser();
    p.push('<<<THINK>>>\n想好了。\n<<<SUBMIT>>>\n```json\n{"bid":420}\n```\n以上。');
    const fin = p.finish();
    expect(fin.content?.bid).toBe(420);
  });

  test("raw newlines inside a string value do not break parsing", () => {
    const p = new SubmissionStreamParser();
    p.push(`<<<SUBMIT>>>\n{"bid":1,"line":"第一行\n第二行"}`);
    const fin = p.finish();
    expect(fin.content?.line).toContain("第二行");
  });

  test("garbage is reported, never thrown", () => {
    const p = new SubmissionStreamParser();
    p.push("<<<THINK>>>\n我什么也不交。");
    const fin = p.finish();
    expect(fin.content).toBeNull();
    expect(fin.anomalies.length).toBeGreaterThan(0);
  });

  test("old ACT marker is tolerated as an alias", () => {
    const p = new SubmissionStreamParser();
    p.push('<<<THINK>>>\nx\n<<<ACT>>>\n{"bid":7}');
    expect(p.finish().content?.bid).toBe(7);
  });

  test("repairJson strips fences and trailing commas", () => {
    expect(JSON.parse(repairJson('```json\n{"a":1,}\n```'))).toEqual({ a: 1 });
  });

  test("parseSubmitPayload rejects non-objects", () => {
    expect(parseSubmitPayload("[1,2,3]").content).toBeNull();
  });
});
