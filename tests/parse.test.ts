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

describe("structured note field", () => {
  test("a note inside the submit JSON is the audience note even without a THINK draft", () => {
    const p = new SubmissionStreamParser({ noteField: true });
    p.push('<<<SUBMIT>>>\n{"note":"写给观众","target":3}');
    const fin = p.finish();
    expect(fin.thinking).toBe("写给观众");
    expect(fin.content).toEqual({ note: "写给观众", target: 3 });
    expect(fin.anomalies).toEqual([]);
  });

  test("the JSON note wins over a live THINK draft", () => {
    const p = new SubmissionStreamParser({ noteField: true });
    p.push('<<<THINK>>>\n草稿\n<<<SUBMIT>>>\n{"note":"正式旁白","target":3}');
    expect(p.finish().thinking).toBe("正式旁白");
  });

  test("a legacy THINK draft still works when the JSON omits note", () => {
    const p = new SubmissionStreamParser({ noteField: true });
    p.push('<<<THINK>>>\n旧旁白\n<<<SUBMIT>>>\n{"target":3}');
    const fin = p.finish();
    expect(fin.thinking).toBe("旧旁白");
    expect(fin.anomalies).not.toContain("missing_note");
  });

  test("missing note is flagged when the payload has none", () => {
    const p = new SubmissionStreamParser({ noteField: true });
    p.push('<<<SUBMIT>>>\n{"target":3}');
    const fin = p.finish();
    expect(fin.thinking).toBe("");
    expect(fin.anomalies).toContain("missing_note");
  });

  test("the rubric parser leaves a slot named note alone", () => {
    const p = new SubmissionStreamParser();
    p.push('<<<SUBMIT>>>\n{"note":"slot","bid":3}');
    const fin = p.finish();
    expect(fin.thinking).toBe("");
    expect(fin.content?.note).toBe("slot");
  });
});

describe("the note field streams while the payload is still arriving", () => {
  test("a note-only payload still feeds the live stream", () => {
    const p = new SubmissionStreamParser({ noteField: true });
    let out = "";
    out += p.push('<<<SUBMIT>>>\n{"note":"第一句');
    out += p.push('，第二句","target":3}');
    expect(out).toBe("第一句，第二句");
    expect(p.finish().thinking).toBe("第一句，第二句");
  });

  test("escaped quotes are decoded instead of ending the note", () => {
    const p = new SubmissionStreamParser({ noteField: true });
    const out = p.push('<<<SUBMIT>>>\n{"note":"他说\\"好\\"","target":3}');
    expect(out).toBe('他说"好"');
  });

  test("a THINK draft is not duplicated by the note field", () => {
    const p = new SubmissionStreamParser({ noteField: true });
    let out = "";
    for (const ch of '<<<THINK>>>\n草稿\n<<<SUBMIT>>>\n{"note":"正式旁白","target":3}') out += p.push(ch);
    expect(out).toContain("草稿");
    expect(out).not.toContain("正式旁白");
    expect(p.finish().thinking).toBe("正式旁白");
  });
});
