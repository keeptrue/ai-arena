import { describe, expect, test } from "bun:test";
import { parseBlueprint } from "../src/engine/blueprint";
import { buildJudgePrompt, buildParticipantPrompt } from "../src/engine/prompt";
import {
  missingTokens,
  missingVariables,
  PROMPT_SLOTS,
  renderPromptTemplate,
  resolvePromptBody,
  templateVariables,
  withGlobalAddendum,
} from "../src/engine/prompt-templates";
import { createMatchState } from "../src/engine/round";
import type { Blueprint, MatchState, ModelSnapshot } from "../src/engine/types";

const BP: Blueprint = parseBlueprint({
  id: "tpl-test",
  name: "模板局",
  tagline: "副标题",
  rounds: 2,
  briefing: "这是一段足够长的规则正文，用来满足最小学数限制。每轮同时提交一个数字和一个陈述。",
  submission: {
    slots: [
      { key: "bid", label: "报价", type: "number", required: true, reveal: "secret" },
      { key: "line", label: "陈述", type: "text", required: true, reveal: "public" },
    ],
  },
  rubric: {
    dimensions: [
      { key: "a", label: "甲", weight: 0.5, hint: "看算计" },
      { key: "b", label: "乙", weight: 0.5, hint: "看表达" },
    ],
  },
  victory: { type: "rubric_total", tiebreaker: "sudden_death", tieThreshold: 0.5 },
});

const MODEL: ModelSnapshot = {
  providerId: "prov-a",
  providerName: "厂商甲",
  kind: "openai",
  baseUrl: "",
  modelId: "model-alpha",
  display: "Alpha-9",
  temperature: 1,
  supportsReasoning: false,
};

function build(): MatchState {
  const state = createMatchState({
    matchId: "m",
    rulesetId: "r",
    blueprint: BP,
    seed: "s",
    teams: [
      { id: "t1", name: "红队", color: "#f00", idx: 0, memberIds: ["p1"], roundScore: 0, totalScore: 3, forfeits: 0 },
      { id: "t2", name: "蓝队", color: "#00f", idx: 1, memberIds: ["p2"], roundScore: 0, totalScore: 2, forfeits: 0 },
    ],
    participants: [
      { id: "p1", seat: 0, teamId: "t1", model: MODEL, status: "ready", forfeits: 0 },
      { id: "p2", seat: 1, teamId: "t2", model: MODEL, status: "ready", forfeits: 0 },
    ],
    judgeModel: MODEL,
    budget: { maxCalls: 10, maxTokens: 0 },
    at: 0,
  });
  state.round = 1;
  state.phase = "collecting";
  return state;
}

describe("template plumbing", () => {
  test("substitutes known placeholders and leaves unknown ones visible", () => {
    expect(renderPromptTemplate("甲{{x}}乙{{missing}}丙", { x: "X" })).toBe("甲X乙{{missing}}丙");
  });

  test("lists placeholders in first-appearance order, without duplicates", () => {
    expect(templateVariables("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  test("reports every required placeholder a body dropped", () => {
    const required = PROMPT_SLOTS["participant.system"].variables
      .filter((v) => v.required)
      .map((v) => v.name);
    expect(missingVariables("participant.system", "一段没有占位符的模板")).toEqual(required);
    expect(missingVariables("participant.system", PROMPT_SLOTS["participant.system"].defaultBody)).toEqual([]);
  });

  test("protocol markers are enforced where the parser depends on them", () => {
    expect(missingTokens("participant.system", "一段没有标记的模板")).toEqual(["<<<THINK>>>", "<<<SUBMIT>>>"]);
    expect(missingTokens("participant.system", PROMPT_SLOTS["participant.system"].defaultBody)).toEqual([]);
    expect(missingTokens("judge.system", "随便写")).toEqual([]);
  });

  test("blank overrides fall back to the built-in body", () => {
    expect(resolvePromptBody("compile.system", "   ")).toBe(PROMPT_SLOTS["compile.system"].defaultBody.trim());
    expect(resolvePromptBody("compile.system", "自定义编译器")).toBe("自定义编译器");
  });

  test("the addendum is appended only when configured", () => {
    expect(withGlobalAddendum("基础", {})).toBe("基础");
    expect(withGlobalAddendum("基础", { "global.addendum": "附加" })).toBe("基础\n\n附加");
  });

  test("compile template receives the engine limits", () => {
    const body = renderPromptTemplate(resolvePromptBody("compile.system"), {
      maxRounds: "7",
      maxSlots: "5",
      maxDimensions: "4",
    });
    expect(body).toContain("1-7");
    expect(body).toContain("1-5");
    expect(body).toContain("2-4");
  });
});

describe("built-in participant prompt", () => {
  const state = build();
  const prompt = buildParticipantPrompt({
    blueprint: BP,
    state,
    participant: state.participants[0],
    interventions: [],
  });

  test("still carries the protocol markers and the slot shape", () => {
    expect(prompt.system).toContain("<<<THINK>>>");
    expect(prompt.system).toContain("<<<SUBMIT>>>");
    expect(prompt.system).toContain('"bid":0');
    expect(prompt.system).toContain('"line":"..."');
  });

  test("fills scene, team and seats", () => {
    expect(prompt.system).toContain("「模板局」—— 副标题");
    expect(prompt.system).toContain("「红队」");
    expect(prompt.system).toContain("队内 1 人");
  });

  test("an override replaces the wording without losing injected facts", () => {
    const custom = buildParticipantPrompt({
      blueprint: BP,
      state,
      participant: state.participants[0],
      interventions: [],
      templates: { "participant.system": "自定义：{{scene}}｜{{team}}｜{{submitShape}}" },
    });
    expect(custom.system.startsWith("自定义：")).toBe(true);
    expect(custom.system).toContain("「模板局」—— 副标题");
    expect(custom.system).toContain('{"bid":0,"line":"..."}');
    expect(custom.system).not.toContain("## 场子");
  });
});

describe("built-in judge prompt", () => {
  const state = build();

  test("an override replaces the wording; the addendum reaches the judge", () => {
    const prompt = buildJudgePrompt({
      blueprint: BP,
      state,
      blindMap: { A: "t1", B: "t2" },
      sudden: false,
      templates: {
        "judge.system": "自定义裁判：{{letters}}｜{{rubric}}｜{{format}}",
        "global.addendum": "全局附加",
      },
    });
    expect(prompt.system.startsWith("自定义裁判：A / B")).toBe(true);
    expect(prompt.system).toContain("`a`「甲」：看算计");
    expect(prompt.system).toContain('"scores"');
    expect(prompt.system.endsWith("全局附加")).toBe(true);
  });

  test("the global addendum also reaches participants", () => {
    const prompt = buildParticipantPrompt({
      blueprint: BP,
      state,
      participant: state.participants[0],
      interventions: [],
      templates: { "global.addendum": "全局附加" },
    });
    expect(prompt.system.endsWith("全局附加")).toBe(true);
  });

  test("sudden-death wording still comes from the format placeholder", () => {
    const prompt = buildJudgePrompt({
      blueprint: BP,
      state,
      blindMap: { A: "t1", B: "t2" },
      sudden: true,
    });
    expect(prompt.system).toContain("这是加时轮");
    expect(prompt.system).toContain('"winner":"A"');
  });
});
