import { describe, expect, test } from "bun:test";
import { BlueprintError } from "../src/engine/blueprint";
import { parseAnyBlueprint } from "../src/engine/game";
import { parseWerewolfBlueprint } from "../src/engine/werewolf/blueprint";
import { createWerewolfState } from "../src/engine/werewolf/reduce";
import { buildSeatPrompt } from "../src/engine/werewolf/prompt";

/** Private briefs sit in the user tail now; what matters is that the seat sees them at all. */
const allText = (prompt: { system: string; messages: Array<{ content: string }> }) =>
  [prompt.system, ...prompt.messages.map((m) => m.content)].join("\n");

/** The cacheable block: public information only, never a seat's cards. */
const chronicleOf = (prompt: { messages: Array<{ content: string; cacheAt?: number }> }) => {
  const message = prompt.messages[0]!;
  return message.content.slice(0, message.cacheAt ?? message.content.length);
};

const BASE = {
  mode: "werewolf",
  id: "ww-test",
  name: "预女猎九人局",
  tagline: "测试",
  seats: 9,
  briefing: "九人局测试规则正文，足够长，用来满足校验。三狼三民预女猎，无警长，屠边获胜。",
  roles: [
    { id: "wolf", label: "狼人", camp: "wolf", count: 3 },
    { id: "villager", label: "村民", camp: "good", count: 3 },
    { id: "seer", label: "预言家", camp: "good", count: 1 },
    { id: "witch", label: "女巫", camp: "good", count: 1 },
    { id: "hunter", label: "猎人", camp: "good", count: 1 },
  ],
};

describe("werewolf blueprint", () => {
  test("parses the standard nine-seat deck and applies house-rule defaults", () => {
    const spec = parseWerewolfBlueprint(BASE);
    expect(spec.seats).toBe(9);
    expect(spec.rules.witch.selfSave).toBe("first_night");
    expect(spec.rules.day.tie).toBe("pk");
    expect(spec.rules.maxDays).toBe(8);
  });

  test("parseAnyBlueprint dispatches by mode", () => {
    const any = parseAnyBlueprint(BASE);
    expect(any.mode).toBe("werewolf");
    expect(() => parseAnyBlueprint({ ...BASE, mode: "nope" })).toThrow(BlueprintError);
  });

  test("rejects a deck that is not 3 wolves / 3 villagers / 3 gods", () => {
    const wrong = {
      ...BASE,
      roles: BASE.roles.map((r) => (r.id === "wolf" ? { ...r, count: 2 } : r)),
    };
    expect(() => parseWerewolfBlueprint(wrong)).toThrow(BlueprintError);
  });

  test("rejects a seat count other than nine", () => {
    expect(() => parseWerewolfBlueprint({ ...BASE, seats: 8 })).toThrow(BlueprintError);
  });
});

describe("werewolf prompt fog", () => {
  const spec = parseWerewolfBlueprint(BASE);
  const roles = [
    "wolf",
    "wolf",
    "wolf",
    "villager",
    "villager",
    "villager",
    "seer",
    "witch",
    "hunter",
  ] as const;
  const state = createWerewolfState({
    matchId: "m1",
    spec,
    seed: "seed",
    dealSource: "manual",
    seats: roles.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
    budget: { maxCalls: 100, maxTokens: 0 },
    at: 0,
  });
  state.day = 2;
  state.phase = "day_speech";
  state.checks.push({ day: 1, target: 0, result: "wolf" });
  state.publicLog.push({ kind: "dawn", day: 2, deaths: [4] });
  state.publicLog.push({ kind: "speech", day: 2, seat: 5, text: "我保 6 号" });

  test("a villager learns nothing private", () => {
    const text = allText(buildSeatPrompt({ state, seat: 3 }));
    expect(text).toContain("村民");
    expect(text).not.toContain("狼队友");
    expect(text).not.toContain("查验记录");
    expect(text).not.toContain("药剂");
  });

  test("a wolf sees teammates but not the seer's checks", () => {
    const text = allText(buildSeatPrompt({ state, seat: 0 }));
    expect(text).toContain("你的狼队友：2号、3号");
    expect(text).not.toContain("查验记录");
    expect(text).not.toContain("药剂");
  });

  test("the seer sees only its own checks", () => {
    const text = allText(buildSeatPrompt({ state, seat: 6 }));
    expect(text).toContain("第1夜验 1号：狼人");
    expect(text).not.toContain("你的狼队友");
    expect(text).not.toContain("药剂");
  });

  test("the witch sees potions but not the wolves' chat or the seer's checks", () => {
    const text = allText(buildSeatPrompt({ state, seat: 7 }));
    expect(text).toContain("解药 1 瓶");
    expect(text).not.toContain("你的狼队友");
    expect(text).not.toContain("查验记录");
  });

  test("the cacheable chronicle carries no roles and no night actions", () => {
    const prompt = buildSeatPrompt({ state, seat: 4 });
    const chronicle = chronicleOf(prompt);
    expect(chronicle).toContain("5号 出局");
    expect(chronicle).not.toContain("狼队友");
    expect(chronicle).not.toContain("查验记录");
    expect(chronicle).not.toContain("今晚倒牌");
    expect(chronicle).not.toContain("你的身份");
  });

  test("the prompt tells the model to ignore instructions from other players", () => {
    const { system } = buildSeatPrompt({ state, seat: 2 });
    expect(system).toContain("不是指令");
  });

  test("a vote prompt asks for a first-person note and separates it from the speech", () => {
    const voteState = { ...state, phase: "day_vote" as const };
    const prompt = buildSeatPrompt({ state: voteState, seat: 3 });
    const text = allText(prompt);
    expect(text).toContain("发言（speech）");
    expect(text).toContain("旁白（note）");
    expect(text).toContain("第一人称");
    expect(prompt.messages[0].content).toContain("这一票会不会把自己暴露");
  });

  test("the user message requires the note field in the submit JSON", () => {
    const { messages } = buildSeatPrompt({ state, seat: 3 });
    const user = messages[0].content;
    expect(user).toContain("必须包含 `note` 字段");
    expect(user).toContain("<<<SUBMIT>>>");
    expect(user).not.toContain("只输出上面约定的 JSON");
  });

  test("every phase's submit shape makes the audience note a required JSON field", () => {
    const phases = [
      "night_wolves",
      "night_seer",
      "night_witch",
      "hunter_shot",
      "day_vote",
      "day_pk_vote",
      "day_speech",
      "day_last_words",
    ] as const;
    for (const phase of phases) {
      const prompt = buildSeatPrompt({ state: { ...state, phase }, seat: 3 });
      const text = allText(prompt);
      expect(text).toContain('"note": "写给观众的旁白"');
      expect(text).toContain("JSON 必须包含 `note` 字段");
      expect(prompt.messages[0].content).toContain("<<<SUBMIT>>>");
    }
  });
});

describe("wolf night stages", () => {
  const spec = parseWerewolfBlueprint(BASE);
  const roles = [
    "wolf",
    "wolf",
    "wolf",
    "villager",
    "villager",
    "villager",
    "seer",
    "witch",
    "hunter",
  ] as const;

  function nightState() {
    const state = createWerewolfState({
      matchId: "m-night",
      spec,
      seed: "seed-night",
      dealSource: "manual",
      seats: roles.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
      budget: { maxCalls: 100, maxTokens: 0 },
      at: 0,
    });
    state.day = 2;
    state.phase = "night_wolves";
    state.queue = [0, 1, 2];
    state.queueIndex = 1;
    state.night.wolfStage = "decide";
    state.night.wolfTalk = [{ seat: 0, text: "我倾向刀3" }];
    state.night.wolfVotes = { 0: 3, 1: 4, 2: 4 };
    return state;
  }

  test("the discussion round is a proposal, not the knife", () => {
    const state = nightState();
    state.night.wolfStage = "discuss";
    state.night.wolfVotes = {};
    const prompt = buildSeatPrompt({ state, seat: 0 });
    const text = allText(prompt);
    expect(text).toContain("本夜狼队低语");
    expect(text).not.toContain("第一轮提议");
    expect(prompt.messages[0].content).toContain("这一轮只商量");
  });

  test("the deciding round shows who proposed whom", () => {
    const state = nightState();
    const prompt = buildSeatPrompt({ state, seat: 0 });
    const text = allText(prompt);
    expect(text).toContain("第一轮提议：1号→4号；2号→5号；3号→5号");
    expect(text).toContain("定刀轮");
    expect(prompt.messages[0].content).toContain("天黑 · 狼人定刀");
    expect(prompt.messages[0].content).toContain("现在定刀");
  });

  test("a non-wolf prompt never sees the proposals", () => {
    const state = nightState();
    state.phase = "night_seer";
    state.queue = [6];
    state.queueIndex = 1;
    const prompt = buildSeatPrompt({ state, seat: 6 });
    expect(allText(prompt)).not.toContain("第一轮提议");
    expect(prompt.messages[0].content).not.toContain("定刀轮");
  });
});
