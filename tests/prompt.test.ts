import { describe, expect, test } from "bun:test";
import { parseBlueprint } from "../src/engine/blueprint";
import { buildJudgePrompt, buildParticipantPrompt } from "../src/engine/prompt";
import { createMatchState } from "../src/engine/round";
import type {
  Blueprint,
  MatchState,
  ModelSnapshot,
  ParticipantState,
  RoundRecord,
  TeamState,
} from "../src/engine/types";

const BP: Blueprint = parseBlueprint({
  id: "td-blind",
  name: "测试局",
  tagline: "",
  rounds: 2,
  briefing: "这是一段足够长的规则正文，用来满足最小学数限制。每轮同时提交一个数字和一个陈述，共两轮。",
  submission: {
    slots: [
      { key: "bid", label: "报价", type: "number", required: true, reveal: "secret" },
      { key: "line", label: "陈述", type: "text", required: true, reveal: "public" },
    ],
  },
  rubric: {
    dimensions: [
      { key: "a", label: "甲", weight: 0.5, hint: "" },
      { key: "b", label: "乙", weight: 0.5, hint: "" },
    ],
  },
  victory: { type: "rubric_total", tiebreaker: "sudden_death", tieThreshold: 0.5 },
});

const MODEL_A: ModelSnapshot = {
  providerId: "prov-a",
  providerName: "厂商甲",
  kind: "openai",
  baseUrl: "",
  modelId: "model-alpha",
  display: "Alpha-9",
  temperature: 1,
  supportsReasoning: false,
};
const MODEL_B: ModelSnapshot = {
  providerId: "prov-b",
  providerName: "厂商乙",
  kind: "openai",
  baseUrl: "",
  modelId: "model-beta",
  display: "Beta-7",
  temperature: 1,
  supportsReasoning: false,
};

function build(): MatchState {
  const teams: TeamState[] = [
    { id: "t1", name: "红队真名", color: "#f00", idx: 0, memberIds: ["p1"], roundScore: 0, totalScore: 3, forfeits: 0 },
    { id: "t2", name: "蓝队真名", color: "#00f", idx: 1, memberIds: ["p2"], roundScore: 0, totalScore: 2, forfeits: 0 },
  ];
  const participants: ParticipantState[] = [
    { id: "p1", seat: 0, teamId: "t1", model: MODEL_A, status: "ready", forfeits: 0 },
    { id: "p2", seat: 1, teamId: "t2", model: MODEL_B, status: "ready", forfeits: 0 },
  ];
  const history: RoundRecord[] = [
    {
      round: 1,
      sudden: false,
      closedAt: 0,
      submissions: [
        { participantId: "p1", seat: 0, teamId: "t1", status: "ready", thinking: "秘密推演甲", content: { bid: 400, line: "我不急" } },
        { participantId: "p2", seat: 1, teamId: "t2", status: "ready", thinking: "秘密推演乙", content: { bid: 500, line: "跟到底" } },
      ],
      verdict: {
        round: 1,
        blindMap: { A: "t1", B: "t2" },
        scores: [],
        verdict: "v",
        publicSummary: "第一轮谁也没亮底",
        judgeModel: MODEL_A,
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      teamScores: { t1: 6, t2: 5 },
    },
  ];

  const state = createMatchState({
    matchId: "m",
    rulesetId: "r",
    blueprint: BP,
    seed: "s",
    teams,
    participants,
    judgeModel: MODEL_A,
    budget: { maxCalls: 10, maxTokens: 0 },
    at: 0,
  });
  state.round = 2;
  state.phase = "collecting";
  state.history = history;
  state.pending = {
    p1: { participantId: "p1", seat: 0, status: "ready", thinking: "本轮秘密甲", content: { bid: 380, line: "我先说" }, raw: "", usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: 0, anomalies: [] },
    p2: { participantId: "p2", seat: 1, status: "ready", thinking: "本轮秘密乙", content: { bid: 700, line: "我全押" }, raw: "", usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: 0, anomalies: [] },
  };
  return state;
}

describe("judge blindness", () => {
  const state = build();
  const prompt = buildJudgePrompt({
    blueprint: BP,
    state,
    blindMap: { A: "t1", B: "t2" },
    sudden: false,
  });
  const flat = prompt.system + JSON.stringify(prompt.messages);

  test("contains no model or provider names", () => {
    for (const name of [MODEL_A.display, MODEL_B.display, MODEL_A.providerName, MODEL_B.providerName, MODEL_A.modelId, MODEL_B.modelId]) {
      expect(flat).not.toContain(name);
    }
  });

  test("contains no team names", () => {
    expect(flat).not.toContain("红队真名");
    expect(flat).not.toContain("蓝队真名");
    expect(flat).toContain("A 方");
  });

  test("contains no thinking, from this round or any earlier one", () => {
    for (const secret of ["秘密推演甲", "秘密推演乙", "本轮秘密甲", "本轮秘密乙"]) {
      expect(flat).not.toContain(secret);
    }
  });

  test("does see secret slot values from this round", () => {
    expect(flat).toContain("380");
    expect(flat).toContain("700");
  });
});

describe("participant fog", () => {
  const state = build();
  const prompt = buildParticipantPrompt({
    blueprint: BP,
    state,
    participant: state.participants[0],
    interventions: [],
  });
  const flat = prompt.system + JSON.stringify(prompt.messages);

  test("never sees the opponent's thinking", () => {
    expect(flat).not.toContain("本轮秘密乙");
    expect(flat).not.toContain("秘密推演乙");
  });

  test("does see the opponent's public line from last round", () => {
    expect(flat).toContain("跟到底");
  });

  test("does not see the opponent's secret bid from last round", () => {
    // Assert on the rendered secret line, not on a bare number: the prompt itself
    // now contains "500 字以内" for the audience note.
    expect(flat).not.toContain("报价：500");
    expect(flat).not.toContain("报价：400");
  });

  test("lists every slot it must fill", () => {
    expect(flat).toContain("`bid`");
    expect(flat).toContain("`line`");
    expect(prompt.system).toContain("<<<SUBMIT>>>");
  });
});
