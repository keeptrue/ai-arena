import { describe, expect, test } from "bun:test";
import { BlueprintError, parseBlueprint } from "../src/engine/blueprint";
import {
  applySettlement,
  foldBoardValues,
  initialBoardValues,
  outOfRange,
  renderSettlementSummary,
  settleRound,
  type MeterValues,
} from "../src/engine/ledger";
import { buildJudgePrompt, buildParticipantPrompt } from "../src/engine/prompt";
import { createMatchState, reduce } from "../src/engine/round";
import type { Blueprint, BoardSettlementCell, ModelSnapshot, Submission, TeamScoreLine } from "../src/engine/types";

const cells: BoardSettlementCell[] = [
  { a: "合作", b: "合作", delta: [{}, {}] },
  { a: "合作", b: "出卖", delta: [{ hp: -3 }, { hp: 1, betray: 1 }] },
  { a: "出卖", b: "合作", delta: [{ hp: 1, betray: 1 }, { hp: -3 }] },
  { a: "出卖", b: "出卖", delta: [{ hp: -2, betray: 1 }, { hp: -2, betray: 1 }] },
];

const fixture = {
  id: "ledger-test",
  name: "账本测试",
  tagline: "",
  rounds: 8,
  briefing: "两人各 18 血，每轮同时选合作或出卖，八轮之后血多者胜。这是一段足够长的规则正文。",
  board: {
    meters: [
      { key: "hp", label: "血量", kind: "bar", min: -6, max: 26, init: 18, threshold: 10 },
      { key: "betray", label: "出卖", kind: "count", min: 0, max: 8, init: 0 },
    ],
    settle: { by: "move", forfeit: "合作", cells },
  },
  submission: {
    slots: [
      { key: "move", label: "选择", type: "choice", choices: ["合作", "出卖"], required: true, reveal: "public" },
    ],
  },
  rubric: {
    dimensions: [
      { key: "bar", label: "血线", weight: 0.98, hint: "", derive: { meter: "hp", base: 5 } },
      { key: "heart", label: "心术", weight: 0.02, hint: "" },
    ],
  },
  victory: { type: "rubric_total", tiebreaker: "sudden_death", tieThreshold: 0.01 },
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

const teams = [
  { id: "red", idx: 0, name: "赤" },
  { id: "blue", idx: 1, name: "蓝" },
];

function start(bp: Blueprint) {
  return createMatchState({
    matchId: "m1",
    rulesetId: "r1",
    blueprint: bp,
    seed: "seed",
    teams: teams.map((t) => ({ ...t, color: "#000", memberIds: [], roundScore: 0, totalScore: 0, forfeits: 0 })),
    participants: [
      { id: "p1", seat: 0, teamId: "red", model, status: "idle", forfeits: 0 },
      { id: "p2", seat: 1, teamId: "blue", model, status: "idle", forfeits: 0 },
    ],
    judgeModel: model,
    budget: { maxCalls: 100, maxTokens: 0 },
    at: 1,
  });
}

function submission(id: string, seat: number, move: string | null): Submission {
  return {
    participantId: id,
    seat,
    status: move === null ? "forfeit" : "ready",
    thinking: "",
    raw: "",
    content: move === null ? {} : { move },
    usage: { promptTokens: 0, completionTokens: 0 },
    latencyMs: 1,
    anomalies: [],
  };
}

function prior(bp: Blueprint): MeterValues {
  return initialBoardValues(bp.board!, ["red", "blue"]);
}

describe("settlement table", () => {
  const bp = parseBlueprint(fixture);

  test("both cooperate: nobody loses blood", () => {
    const settled = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: "合作" },
        { teamId: "blue", value: "合作" },
      ],
      prior: prior(bp),
      round: 1,
    });
    expect(settled?.sides.map((s) => s.state)).toEqual([
      { hp: 18, betray: 0 },
      { hp: 18, betray: 0 },
    ]);
  });

  test("one betrays: the cooperator pays 3, the betrayer gains 1", () => {
    const settled = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: "合作" },
        { teamId: "blue", value: "出卖" },
      ],
      prior: prior(bp),
      round: 1,
    });
    const red = settled!.sides.find((s) => s.teamId === "red")!;
    const blue = settled!.sides.find((s) => s.teamId === "blue")!;
    expect(red.state).toEqual({ hp: 15, betray: 0 });
    expect(blue.state).toEqual({ hp: 19, betray: 1 });
  });

  test("a forfeit stands in as the declared value, and says so", () => {
    const settled = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: null },
        { teamId: "blue", value: "出卖" },
      ],
      prior: prior(bp),
      round: 4,
    });
    expect(settled!.substituted).toBe(true);
    expect(settled!.sides[0].move).toBeNull();
    expect(settled!.sides[0].state.hp).toBe(15);
    expect(settled!.summary).toContain("赤 弃权记合作");
  });

  test("eight betrayals end at 2 blood each, and the ledger never clamps", () => {
    let running = prior(bp);
    for (let round = 1; round <= 8; round++) {
      const settled = settleRound({
        board: bp.board!,
        teams,
        moves: [
          { teamId: "red", value: "出卖" },
          { teamId: "blue", value: "出卖" },
        ],
        prior: running,
        round,
      })!;
      running = Object.fromEntries(settled.sides.map((s) => [s.teamId, s.state]));
    }
    expect(running.red).toEqual({ hp: 2, betray: 8 });
    expect(running.blue).toEqual({ hp: 2, betray: 8 });
    expect(outOfRange(bp.board, null)).toEqual([]);
  });

  test("a reading below the declared floor is reported, not silently corrected", () => {
    const settled = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: "出卖" },
        { teamId: "blue", value: "出卖" },
      ],
      prior: { red: { hp: -6, betray: 0 }, blue: { hp: 18, betray: 0 } },
      round: 8,
    })!;
    expect(settled.sides[0].state.hp).toBe(-8);
    expect(outOfRange(bp.board, settled)).toEqual([{ meter: "hp", limit: "min", value: -8 }]);
  });

  test("never guesses an undeclared combination", () => {
    const broken = parseBlueprint(fixture);
    const settled = settleRound({
      board: { ...broken.board!, settle: { ...broken.board!.settle!, cells: cells.slice(0, 2) } },
      teams,
      moves: [
        { teamId: "red", value: "出卖" },
        { teamId: "blue", value: "出卖" },
      ],
      prior: prior(bp),
      round: 1,
    });
    expect(settled).toBeNull();
  });

  test("three sides cannot be settled by a two-sided table", () => {
    const settled = settleRound({
      board: bp.board!,
      teams: [...teams, { id: "green", idx: 2, name: "绿" }],
      moves: [
        { teamId: "red", value: "合作" },
        { teamId: "blue", value: "合作" },
        { teamId: "green", value: "合作" },
      ],
      prior: prior(bp),
      round: 1,
    });
    expect(settled).toBeNull();
  });
});

describe("ledger summary", () => {
  const bp = parseBlueprint(fixture);

  test("is keyed by team name, never by blind letters", () => {
    const settled = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: "合作" },
        { teamId: "blue", value: "出卖" },
      ],
      prior: prior(bp),
      round: 4,
    })!;
    expect(settled.summary).toBe("血量：赤 15 / 蓝 19（出卖 赤 0 次 / 蓝 1 次）｜本轮 赤 合作、蓝 出卖 → 赤 -3、蓝 +1");
    expect(settled.summary).not.toMatch(/\bA\b|\bB\b/);
  });

  test("renders whichever meters the ruleset declared", () => {
    const summary = renderSettlementSummary({
      board: bp.board!,
      teams,
      sides: [
        { teamId: "red", move: "出卖", delta: { hp: 1 }, state: { hp: 19, betray: 3 } },
        { teamId: "blue", move: "合作", delta: { hp: -3 }, state: { hp: 15, betray: 0 } },
      ],
      forfeit: "合作",
    });
    expect(summary).toContain("血量：赤 19 / 蓝 15");
    expect(summary).toContain("出卖 赤 3 次 / 蓝 0 次");
  });
});

describe("judge / ledger arbitration", () => {
  const bp = parseBlueprint(fixture);
  const settlement = settleRound({
    board: bp.board!,
    teams,
    moves: [
      { teamId: "red", value: "出卖" },
      { teamId: "blue", value: "出卖" },
    ],
    prior: prior(bp),
    round: 5,
  })!;

  const judgeLines: TeamScoreLine[] = [
    { teamId: "red", dimensions: { bar: 4.5, heart: 0 }, weighted: 4.41, notes: "", state: { hp: 13, betray: 1 } },
    { teamId: "blue", dimensions: { bar: 3, heart: 0 }, weighted: 2.94, notes: "", state: { hp: 17, betray: 2 } },
  ];

  test("overwrites the readings and derives the mechanical dimension", () => {
    const { scores } = applySettlement({
      settlement,
      board: bp.board!,
      dimensions: bp.rubric.dimensions,
      scores: judgeLines,
    });
    const red = scores.find((s) => s.teamId === "red")!;
    expect(red.state).toEqual({ hp: 16, betray: 1 });
    expect(red.dimensions.bar).toBe(3);
    expect(red.weighted).toBeCloseTo(3 * 0.98, 3);
  });

  test("reports every correction it had to make", () => {
    const { corrections } = applySettlement({
      settlement,
      board: bp.board!,
      dimensions: bp.rubric.dimensions,
      scores: judgeLines,
    });
    expect(corrections.some((c) => c.kind === "derive" && c.field === "bar" && c.engine === 3)).toBe(true);
    expect(corrections.some((c) => c.kind === "state" && c.field === "hp")).toBe(true);
  });

  test("leaves the judge-owned dimension alone", () => {
    const lines = judgeLines.map((l) => ({ ...l, dimensions: { ...l.dimensions, heart: 7 } }));
    const { scores } = applySettlement({
      settlement,
      board: bp.board!,
      dimensions: bp.rubric.dimensions,
      scores: lines,
    });
    expect(scores[0].dimensions.heart).toBe(7);
  });

  test("a judge that omits the readings is filled in silently", () => {
    const { scores, corrections } = applySettlement({
      settlement,
      board: bp.board!,
      dimensions: bp.rubric.dimensions,
      scores: [
        { teamId: "red", dimensions: { heart: 0 }, weighted: 0, notes: "" },
        { teamId: "blue", dimensions: { heart: 0 }, weighted: 0, notes: "" },
      ],
    });
    expect(scores.find((s) => s.teamId === "red")!.state).toEqual({ hp: 16, betray: 1 });
    expect(corrections).toEqual([]);
  });
});

describe("fold", () => {
  const bp = parseBlueprint(fixture);

  test("a settled round wins over whatever the judge wrote", () => {
    const settlement = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: "合作" },
        { teamId: "blue", value: "出卖" },
      ],
      prior: prior(bp),
      round: 1,
    });
    const values = foldBoardValues(bp.board, ["red", "blue"], [
      {
        round: 1,
        settlement,
        verdict: { scores: [{ teamId: "red", state: { hp: 99 } }] },
      },
    ]);
    expect(values.red.hp).toBe(15);
    expect(values.blue.hp).toBe(19);
  });
});

describe("blueprint validation", () => {
  test("rejects a feed that does not cover every combination", () => {
    const bad = { ...fixture, board: { ...fixture.board, settle: { ...fixture.board.settle, cells: cells.slice(0, 3) } } };
    expect(() => parseBlueprint(bad)).toThrow(BlueprintError);
    expect(() => parseBlueprint(bad)).toThrow(/缺少组合/);
  });

  test("rejects a forfeit value that is not a choice", () => {
    const bad = { ...fixture, board: { ...fixture.board, settle: { ...fixture.board.settle, forfeit: "投降" } } };
    expect(() => parseBlueprint(bad)).toThrow(/forfeit/);
  });

  test("rejects a delta on an undeclared meter", () => {
    const bad = {
      ...fixture,
      board: {
        ...fixture.board,
        settle: {
          ...fixture.board.settle,
          cells: cells.map((c, i) => (i === 3 ? { ...c, delta: [{ hp: -2, luck: 1 }, { hp: -2 }] } : c)),
        },
      },
    };
    expect(() => parseBlueprint(bad)).toThrow(/未声明的指标/);
  });

  test("rejects a derived dimension without a ledger", () => {
    const { settle, ...board } = fixture.board;
    expect(() => parseBlueprint({ ...fixture, board })).toThrow(/settle/);
  });
});

describe("prompts with a ledger", () => {
  const bp = parseBlueprint(fixture);

  function roundFive() {
    let state = start(bp);
    state = reduce(state, { kind: "start", at: 2 }).state;
    for (let round = 1; round <= 4; round++) {
      state = reduce(state, { kind: "submit", submission: submission("p1", 0, "合作") }).state;
      state = reduce(state, { kind: "submit", submission: submission("p2", 1, "合作") }).state;
      const settlement = settleRound({
        board: bp.board!,
        teams,
        moves: [
          { teamId: "red", value: "合作" },
          { teamId: "blue", value: "合作" },
        ],
        prior: foldBoardValues(bp.board, ["red", "blue"], state.history),
        round,
      })!;
      state = reduce(state, {
        kind: "verdict",
        verdict: {
          round,
          blindMap: { A: "red", B: "blue" },
          scores: [
            { teamId: "red", dimensions: { bar: 5, heart: 0 }, weighted: 4.9, notes: "", state: { hp: 18, betray: 0 } },
            { teamId: "blue", dimensions: { bar: 5, heart: 0 }, weighted: 4.9, notes: "", state: { hp: 18, betray: 0 } },
          ],
          verdict: "A 掉 3 血，B 领先",
          publicSummary: "血量：A 15 / B 19",
          judgeModel: model,
          usage: { promptTokens: 0, completionTokens: 0 },
          settlement,
        },
      }).state;
    }
    state = reduce(state, { kind: "submit", submission: submission("p1", 0, "出卖") }).state;
    state = reduce(state, { kind: "submit", submission: submission("p2", 1, "出卖") }).state;
    return state;
  }

  test("the judge's history never shows an old letter next to a number", () => {
    const state = roundFive();
    const settlement = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: "出卖" },
        { teamId: "blue", value: "出卖" },
      ],
      prior: foldBoardValues(bp.board, ["red", "blue"], state.history),
      round: 5,
    });
    // Round 5 flips the map: A is now blue.
    const prompt = buildJudgePrompt({
      blueprint: bp,
      state,
      blindMap: { A: "blue", B: "red" },
      sudden: false,
      settlement,
    });
    const user = prompt.messages[0].content;
    expect(user).not.toContain("血量：A 15 / B 19");
    expect(user).not.toContain("A 掉 3 血");
    expect(user).toContain("本轮账面");
    // History is re-lettered into the current map: blue is A, so A must read 18.
    expect(user).toMatch(/A 合作（血量 18、出卖 0）/);
    expect(prompt.system).toContain("每轮重新分配");
    expect(prompt.system).toContain("不要自己加减");
  });

  test("the judge is not asked for derived dimensions", () => {
    const state = roundFive();
    const prompt = buildJudgePrompt({
      blueprint: bp,
      state,
      blindMap: { A: "red", B: "blue" },
      sudden: false,
      settlement: null,
    });
    expect(prompt.system).toContain('"heart":0');
    expect(prompt.system).not.toContain('"bar":0');
    expect(prompt.system).toContain("由引擎按规则结算");
  });

  test("participants read the ledger by team name", () => {
    const state = roundFive();
    const settlement = settleRound({
      board: bp.board!,
      teams,
      moves: [
        { teamId: "red", value: "合作" },
        { teamId: "blue", value: "出卖" },
      ],
      prior: foldBoardValues(bp.board, ["red", "blue"], state.history),
      round: 5,
    });
    state.history[state.history.length - 1].settlement = settlement;
    const prompt = buildParticipantPrompt({
      blueprint: bp,
      state,
      participant: state.participants[0],
      interventions: [],
    });
    const user = prompt.messages[0].content;
    expect(user).toContain("赤 15");
    expect(user).toContain("上一轮出手：赤 合作、蓝 出卖");
  });
});
