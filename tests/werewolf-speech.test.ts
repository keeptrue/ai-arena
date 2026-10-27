import { describe, expect, test } from "bun:test";
import { salvageSpeech } from "../src/engine/werewolf/speech";

describe("salvageSpeech", () => {
  test("returns plain prose untouched", () => {
    expect(salvageSpeech("3号遗言：我是女巫。")).toBe("3号遗言：我是女巫。");
  });

  test("pulls the line out of a full protocol dump", () => {
    const raw = '<<<THINK>>>\n我在想刀谁。\n<<<SUBMIT>>>\n{"speech": "我是女巫，昨晚是我开的药。"}';
    expect(salvageSpeech(raw)).toBe("我是女巫，昨晚是我开的药。");
  });

  test("tolerates a truncated payload", () => {
    const raw = '<<<THINK>>>\n想。\n<<<SUBMIT>>>\n{"speech": "3号遗言，直接掏底牌';
    expect(salvageSpeech(raw)).toBe("3号遗言，直接掏底牌");
  });

  test("unescapes quotes and newlines", () => {
    const raw = '{"speech": "他说\\"我是女巫\\"\\n然后走了"}';
    expect(salvageSpeech(raw)).toBe('他说"我是女巫"\n然后走了');
  });

  test("a malformed payload without a speech key yields nothing", () => {
    expect(salvageSpeech('<<<THINK>>>\n想。\n<<<SUBMIT>>>\n{"target": 7}')).toBe("");
  });

  test("a payload without markers but with a speech key still works", () => {
    expect(salvageSpeech('{"text": "过麦"}')).toBe("过麦");
  });

  test("an empty turn yields nothing", () => {
    expect(salvageSpeech("   ")).toBe("");
  });
});
