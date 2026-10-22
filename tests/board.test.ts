import { describe, expect, test } from "bun:test";
import { BlueprintError, parseBlueprint } from "../src/engine/blueprint";
import { buildJudgePrompt, buildParticipantPrompt } from "../src/engine/prompt";
import { createMatchState, reduce } from "../src/engine/round";
import type { Blueprint, JudgeVerdict, ModelSnapshot, Submission } from "../src/engine/types";
import { boardDelta, foldBoard, parseBoardState, parseMarks } from "../src/lib/board";

const base = {
  id: "board-test",
  name: "面板测试",
  tagline: "",
  rounds: 3,
  briefing: "这是一段足够长的规则正文，用来满足最小字数限制，也让选手有东西可读。每轮同时提交一个数字。",
  board: {
    meters: [
      { key: "hp", label: "血量", kind: "bar", min: -6, max: 26, init: 18, threshold: 10 },
      { key: "pos", label: "山道", kind: "track", min: 0, max: 40, init: 0 },
      { key: "mines", label: "雷", kind: "count", min: 0, max: 4, init: 3 },
    ],
    marks: { label: "雷位" },
  },
  submission: {
    slots: [{ key: "move", label: "选择", type: "choice", choices: ["合作", "出卖"], required: true, reveal: "public" }],
  },
  rubric: {
    dimensions: [
      { key: "a", label: "甲", weight: 0.5, hint: "" },
      { key: "b", label: "乙", weight: 0.5, hint: "" },
    ],
  },
  victory: { type: "rubric_total", tiebreaker: "sudden_death", tieThreshold: 0.5 },
};

const model: ModelSnapshot = {
  providerId: "p",
  providerName: "P",
  kind: "mock",
  baseUrl: "",
  modelId: "m",
  display: "m",
  temperature: 1,
  supportsReasoning: false,
};

function buildState(bp: Blueprint) {
  return createMatchState({
    matchId: "m1",
    rulesetId: "r1",
    blueprint: bp,
    seed: "s",
    teams: [
      { id: "t1", name: "赤", color: "#f00", idx: 0, memberIds: ["p1"], roundScore: 0, totalScore: 0, forfeits: 0 },
      { id: "t2", name: "青", color: "#0ff", idx: 1, memberIds: ["p2"], roundScore: 0, totalScore: 0, forfeits: 0 },
    ],
    participants: [
      { id: "p1", seat: 1, teamId: "t1", model, status: "idle", forfeits: 0 },
      { id: "p2", seat: 2, teamId: "t2", model, status: "idle", forfeits: 0 },
    ],
    judgeModel: model,
    budget: { maxCalls: 100, maxTokens: 0 },
    at: 1,
  });
}

function submit(state: ReturnType<typeof buildState>, id: string, seat: number): ReturnType<typeof buildState> {
  const sub: Submission = {
    participantId: id,
    seat,
    status: "ready",
    thinking: "",
    raw: "",
    content: { move: "合作" },
    usage: { promptTokens: 0, completionTokens: 0 },
    latencyMs: 1,
    anomalies: [],
  };
  return reduce(state, { kind: "submit", submission: sub }).state;
}

describe("board schema", () => {
  test("fills defaults and keeps declared ranges", () => {
    const bp = parseBlueprint(base);
    expect(bp.board?.meters[0].init).toBe(18);
    expect(bp.board?.meters[0].min).toBe(-6);
    expect(bp.board?.marks?.label).toBe("雷位");
  });

  test("accepts a blueprint with no board at all", () => {
    const { board, ...rest } = base;
    expect(parseBlueprint(rest).board).toBeUndefined();
  });

  test("rejects duplicate meter keys", () => {
    const bad = { ...base, board: { meters: [...base.board.meters, { ...base.board.meters[2] }] } };
    expect(() => parseBlueprint(bad)).toThrow(BlueprintError);
  });

  test("rejects an inverted range", () => {
    const bad = { ...base, board: { meters: [{ key: "hp", label: "血量", kind: "bar", max: 0 }] } };
    expect(() => parseBlueprint(bad)).toThrow(/max 必须大于 min/);
  });

  test("rejects a threshold outside the range", () => {
    const bad = {
      ...base,
      board: { meters: [{ key: "hp", label: "血量", kind: "bar", max: 10, threshold: 11 }] },
    };
    expect(() => parseBlueprint(bad)).toThrow(/threshold/);
  });

  test("rejects two tracks", () => {
    const bad = {
      ...base,
      board: {
        meters: [
          { key: "a", label: "甲", kind: "track", max: 10 },
          { key: "b", label: "乙", kind: "track", max: 10 },
        ],
      },
    };
    expect(() => parseBlueprint(bad)).toThrow(/track/);
  });

  test("rejects marks without a track", () => {
    const bad = {
      ...base,
      board: { meters: [{ key: "hp", label: "血量", kind: "bar", max: 10 }], marks: { label: "雷位" } },
    };
    expect(() => parseBlueprint(bad)).toThrow(/marks/);
  });
});

describe("board read-out", () => {
  const board = parseBlueprint(base).board!;

  test("clamps to the declared range and flags it", () => {
    const { state, issues } = parseBoardState(board, { hp: 99, pos: -3, mines: 2 });
    expect(state).toEqual({ hp: 26, pos: 0, mines: 2 });
    expect(issues.map((i) => i.code)).toContain("state_clamped");
  });

  test("drops unknown keys and non-numbers", () => {
    const { state, issues } = parseBoardState(board, { hp: "13", luck: 5, pos: "far" });
    expect(state).toEqual({ hp: 13 });
    expect(issues.map((i) => i.code)).toContain("state_unknown");
  });

  test("returns nothing for a blueprint without a board", () => {
    const { state, issues } = parseBoardState(undefined, { hp: 3 });
    expect(state).toEqual({});
    expect(issues).toEqual([]);
  });

  test("filters marks to the track, dedupes and sorts", () => {
    const { marks } = parseMarks(board, [17, 3, 17, 99, 2.5, "8"]);
    expect(marks).toEqual([3, 8, 17]);
  });

  test("folds rounds with init and carry-forward", () => {
    const snapshot = foldBoard(board, ["t1", "t2"], [
      { round: 1, verdict: { scores: [{ teamId: "t1", state: { hp: 15 } }] } },
      { round: 2, verdict: { scores: [{ teamId: "t1", state: { hp: 13, pos: 5 } }] } },
    ]);
    expect(snapshot.values.t1.hp).toBe(13);
    expect(snapshot.values.t1.pos).toBe(5);
    expect(snapshot.values.t1.mines).toBe(3);
    expect(snapshot.values.t2.hp).toBe(18);
    expect(snapshot.round).toBe(2);
    expect(snapshot.stale).toBe(false);
  });

  test("marks a stale snapshot when the last round carried no reading", () => {
    const snapshot = foldBoard(board, ["t1"], [
      { round: 1, verdict: { scores: [{ teamId: "t1", state: { hp: 15 } }] } },
      { round: 2, verdict: { scores: [{ teamId: "t1" }] } },
    ]);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.values.t1.hp).toBe(15);
  });

  test("computes deltas only for known values", () => {
    expect(boardDelta({ hp: 15, pos: 3 }, { hp: 13, pos: 8 })).toEqual({ hp: -2, pos: 5 });
  });
});

describe("board plumbing", () => {
  const bp = parseBlueprint(base);

  test("match.created carries the board spec", () => {
    const { effects } = reduce(buildState(bp), { kind: "start", at: 2 });
    const created = effects.find((e) => e.kind === "emit" && e.event.type === "match.created");
    expect(created && created.kind === "emit" ? created.event.payload.board : null).toEqual(bp.board);
  });

  test("judge prompt asks for state/marks only when declared", () => {
    let state = reduce(buildState(bp), { kind: "start", at: 2 }).state;
    state = submit(state, "p1", 1);
    state = submit(state, "p2", 2);
    const withBoard = buildJudgePrompt({ blueprint: bp, state, blindMap: { A: "t1", B: "t2" }, sudden: false });
    expect(withBoard.system).toContain('"state":{"A":{"hp":0,"pos":0,"mines":0}');
    expect(withBoard.system).toContain('"marks":[]');
    expect(withBoard.system).toContain("本轮结束后的绝对值");

    const { board, ...rest } = base;
    const plain = parseBlueprint(rest);
    const bare = buildJudgePrompt({ blueprint: plain, state, blindMap: { A: "t1", B: "t2" }, sudden: false });
    expect(bare.system).not.toContain('"state"');
    expect(bare.system).not.toContain('"marks"');
  });

  test("round.verdict carries marks and per-team state", () => {
    let state = reduce(buildState(bp), { kind: "start", at: 2 }).state;
    state = submit(state, "p1", 1);
    state = submit(state, "p2", 2);
    const verdict: JudgeVerdict = {
      round: 1,
      blindMap: { A: "t1", B: "t2" },
      scores: [
        { teamId: "t1", dimensions: { a: 6, b: 6 }, weighted: 6, notes: "", state: { hp: 15 } },
        { teamId: "t2", dimensions: { a: 5, b: 5 }, weighted: 5, notes: "", state: { hp: 11 } },
      ],
      verdict: "",
      publicSummary: "血量 15 / 11",
      judgeModel: model,
      usage: { promptTokens: 0, completionTokens: 0 },
      marks: [3, 17],
    };
    const { effects } = reduce(state, { kind: "verdict", verdict });
    const emitted = effects.find((e) => e.kind === "emit" && e.event.type === "round.verdict");
    const payload = emitted && emitted.kind === "emit" ? emitted.event.payload : {};
    expect(payload.marks).toEqual([3, 17]);
    const scores = payload.scores as Array<{ state?: Record<string, number> }>;
    expect(scores[0].state).toEqual({ hp: 15 });
  });

  test("participants see the last board reading in plain text", () => {
    let state = reduce(buildState(bp), { kind: "start", at: 2 }).state;
    state = submit(state, "p1", 1);
    state = submit(state, "p2", 2);
    state = reduce(state, {
      kind: "verdict",
      verdict: {
        round: 1,
        blindMap: { A: "t1", B: "t2" },
        scores: [
          { teamId: "t1", dimensions: { a: 6, b: 6 }, weighted: 6, notes: "", state: { hp: 15, pos: 0, mines: 3 } },
          { teamId: "t2", dimensions: { a: 5, b: 5 }, weighted: 5, notes: "", state: { hp: 11, pos: 0, mines: 3 } },
        ],
        verdict: "",
        publicSummary: "",
        judgeModel: model,
        usage: { promptTokens: 0, completionTokens: 0 },
      },
    }).state;
    const prompt = buildParticipantPrompt({ blueprint: bp, state, participant: state.participants[0], interventions: [] });
    expect(prompt.messages[0].content).toContain("战况读数（第 1 轮结束时）");
    expect(prompt.messages[0].content).toContain("血量：赤 15 / 青 11");
  });
});
