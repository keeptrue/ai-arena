import { describe, expect, test } from "bun:test";
import { parseBlueprint } from "../src/engine/blueprint";
import {
  allCollected,
  blindMapFor,
  budgetExhausted,
  createMatchState,
  reduce,
} from "../src/engine/round";
import type {
  Blueprint,
  Effect,
  JudgeVerdict,
  MatchState,
  ModelSnapshot,
  ParticipantState,
  Submission,
  TeamState,
} from "../src/engine/types";

const BP: Blueprint = parseBlueprint({
  id: "td-sim",
  name: "测试局",
  tagline: "",
  rounds: 3,
  briefing: "这是一段足够长的规则正文，用来满足最小学数限制。每轮同时提交一个数字和一个陈述，共三轮。",
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

function model(i: number): ModelSnapshot {
  return {
    providerId: `prov-${i}`,
    providerName: `厂${i}`,
    kind: "openai",
    baseUrl: "",
    modelId: `m-${i}`,
    display: `模型${i}`,
    temperature: 1,
    supportsReasoning: false,
  };
}

function buildState(teamSizes: number[], seed = "seed-1") {
  const teams: TeamState[] = teamSizes.map((size, i) => ({
    id: `team-${i}`,
    name: `第${i}方`,
    color: "#fff",
    idx: i,
    memberIds: [],
    roundScore: 0,
    totalScore: 0,
    forfeits: 0,
  }));
  const participants: ParticipantState[] = [];
  let seat = 0;
  teamSizes.forEach((size, ti) => {
    for (let k = 0; k < size; k++) {
      const p: ParticipantState = {
        id: `part-${seat}`,
        seat,
        teamId: teams[ti].id,
        model: model(seat),
        status: "idle",
        forfeits: 0,
      };
      participants.push(p);
      teams[ti].memberIds.push(p.id);
      seat += 1;
    }
  });
  return createMatchState({
    matchId: "match-sim",
    rulesetId: "rs",
    blueprint: BP,
    seed,
    teams,
    participants,
    judgeModel: model(0),
    budget: { maxCalls: 1000, maxTokens: 0 },
    at: 0,
  });
}

interface PlayOptions {
  teamSizes?: number[];
  seed?: string;
  order?: "forward" | "reverse";
  forfeit?: (participantId: string, round: number) => boolean;
  scoreFor?: (teamId: string, round: number) => number;
  suddenWinner?: string;
}

function play(opts: PlayOptions = {}) {
  const teamSizes = opts.teamSizes ?? [1, 1];
  let state = buildState(teamSizes, opts.seed ?? "seed-1");
  const trace: string[] = [];

  const submissionFor = (p: ParticipantState, round: number): Submission => {
    const isForfeit = opts.forfeit?.(p.id, round) ?? false;
    return {
      participantId: p.id,
      seat: p.seat,
      status: isForfeit ? "forfeit" : "ready",
      thinking: `${p.id} 第${round}轮推演`,
      content: isForfeit ? {} : { bid: 100 + p.seat * 10 + round, line: `${p.id} 的话` },
      raw: "",
      usage: { promptTokens: 10, completionTokens: 10 },
      latencyMs: 1,
      anomalies: isForfeit ? ["forced"] : [],
    };
  };

  const verdictFor = (s: MatchState, round: number, sudden: boolean): JudgeVerdict => {
    const blindMap = blindMapFor(s.seed, round, s.teams.map((t) => t.id));
    const scoreFor = opts.scoreFor ?? ((teamId: string) => (teamId === "team-0" ? 8 : 6));
    return {
      round,
      blindMap,
      scores: s.teams.map((t) => ({
        teamId: t.id,
        dimensions: { a: scoreFor(t.id, round), b: scoreFor(t.id, round) },
        weighted: scoreFor(t.id, round),
        notes: "",
      })),
      verdict: "测试判词",
      publicSummary: "测试战况",
      judgeModel: model(0),
      usage: { promptTokens: 5, completionTokens: 5 },
      suddenWinnerTeamId: sudden ? (opts.suddenWinner ?? s.teams[0].id) : null,
    };
  };

  let queue: Effect[] = [...reduce(state, { kind: "start", at: 0 }).effects];
  state = reduce(state, { kind: "start", at: 0 }).state;

  let guard = 0;
  while (queue.length > 0 && guard++ < 5000) {
    const effect = queue.shift()!;
    if (effect.kind === "emit") {
      trace.push(effect.event.type);
      continue;
    }
    if (effect.kind === "finish") {
      trace.push(`finish:${effect.reason}`);
      break;
    }
    if (effect.kind === "call_participants") {
      const ids = opts.order === "reverse" ? [...effect.ids].reverse() : effect.ids;
      for (const id of ids) {
        const p = state.participants.find((x) => x.id === id)!;
        const res = reduce(state, { kind: "submit", submission: submissionFor(p, state.round) });
        state = res.state;
        queue.push(...res.effects);
      }
      continue;
    }
    if (effect.kind === "call_judge") {
      const res = reduce(state, {
        kind: "verdict",
        verdict: verdictFor(state, effect.round, effect.sudden),
      });
      state = res.state;
      queue.push(...res.effects);
      continue;
    }
  }

  return { state, trace };
}

describe("round engine", () => {
  test("does not judge until every participant has submitted", () => {
    let state = buildState([1, 2]);
    const started = reduce(state, { kind: "start", at: 0 });
    state = started.state;
    expect(state.phase).toBe("collecting");

    const first = reduce(state, {
      kind: "submit",
      submission: {
        participantId: "part-0",
        seat: 0,
        status: "ready",
        thinking: "",
        content: { bid: 1, line: "x" },
        raw: "",
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
        anomalies: [],
      },
    });
    state = first.state;
    expect(state.phase).toBe("collecting");
    expect(allCollected(state)).toBe(false);
    expect(first.effects.some((e) => e.kind === "call_judge")).toBe(false);
  });

  test("submission order does not change the outcome", () => {
    const a = play({ order: "forward", seed: "order-seed" });
    const b = play({ order: "reverse", seed: "order-seed" });
    expect(a.state.winnerTeamId).toBe(b.state.winnerTeamId);
    expect(JSON.stringify(a.state.teams.map((t) => t.totalScore))).toBe(
      JSON.stringify(b.state.teams.map((t) => t.totalScore)),
    );
  });

  test("runs the configured number of rounds then finishes", () => {
    const { state, trace } = play();
    expect(state.phase).toBe("done");
    expect(state.history.length).toBe(BP.rounds);
    expect(state.endReason).toBe("rubric_total");
    expect(trace.filter((t) => t === "round.closed").length).toBe(BP.rounds);
  });

  test("2v2 seats four participants and scores each side once", () => {
    const { state } = play({ teamSizes: [2, 2], scoreFor: (t) => (t === "team-0" ? 7 : 5) });
    expect(state.participants.length).toBe(4);
    expect(state.teams[0].totalScore).toBeGreaterThan(0);
    // One score per side per round — not per member.
    expect(state.teams[0].totalScore).toBeCloseTo(7 * BP.rounds, 3);
  });

  test("a 1v2 side is not advantaged by headcount", () => {
    const { state } = play({ teamSizes: [1, 2], scoreFor: () => 6 });
    expect(state.teams[0].totalScore).toBeCloseTo(state.teams[1].totalScore, 3);
  });

  test("forfeits are recorded and do not block the round", () => {
    const { state, trace } = play({ forfeit: (id, round) => round === 1 && id === "part-1" });
    expect(trace).toContain("seat.forfeit");
    expect(state.history.length).toBe(BP.rounds);
    expect(state.teams[1].forfeits).toBe(1);
  });

  test("two forfeits from one side ends the match early", () => {
    const { state } = play({
      teamSizes: [1, 2],
      forfeit: (id) => id === "part-0",
    });
    expect(state.endReason).toBe("forfeit_limit");
    expect(state.winnerTeamId).toBe("team-1");
  });

  test("a tie triggers one sudden-death round", () => {
    const { state, trace } = play({
      scoreFor: () => 7,
      suddenWinner: "team-1",
    });
    expect(state.endReason).toBe("sudden_death");
    expect(state.winnerTeamId).toBe("team-1");
    expect(trace.filter((t) => t === "round.opened").length).toBe(BP.rounds + 1);
    const suddenRounds = state.history.filter((r) => r.sudden);
    expect(suddenRounds.length).toBe(1);
    // Sudden death does not add rubric points.
    expect(state.teams[0].totalScore).toBeCloseTo(7 * BP.rounds, 3);
  });

  test("a clear margin skips sudden death", () => {
    const { state, trace } = play({ scoreFor: (t) => (t === "team-0" ? 9 : 5) });
    expect(state.endReason).toBe("rubric_total");
    expect(trace.filter((t) => t === "round.opened").length).toBe(BP.rounds);
  });

  test("duplicate submissions for the same seat are ignored", () => {
    let state = buildState([1, 1]);
    state = reduce(state, { kind: "start", at: 0 }).state;
    const sub: Submission = {
      participantId: "part-0",
      seat: 0,
      status: "ready",
      thinking: "",
      content: { bid: 5, line: "x" },
      raw: "",
      usage: { promptTokens: 1, completionTokens: 1 },
      latencyMs: 1,
      anomalies: [],
    };
    state = reduce(state, { kind: "submit", submission: sub }).state;
    const again = reduce(state, {
      kind: "submit",
      submission: { ...sub, content: { bid: 999, line: "y" } },
    });
    expect(again.state.pending["part-0"].content.bid).toBe(5);
    expect(again.effects.length).toBe(0);
  });
});

describe("budget guard", () => {
  test("blocks before exceeding maxCalls", () => {
    expect(budgetExhausted({ calls: 4, maxCalls: 5, tokens: 0, maxTokens: 100 })).toBe(false);
    expect(budgetExhausted({ calls: 5, maxCalls: 5, tokens: 0, maxTokens: 100 })).toBe(true);
  });
  test("token usage never blocks a round", () => {
    expect(budgetExhausted({ calls: 1, maxCalls: 5, tokens: 100, maxTokens: 100 })).toBe(false);
    expect(budgetExhausted({ calls: 1, maxCalls: 5, tokens: 101, maxTokens: 100 })).toBe(false);
    expect(budgetExhausted({ calls: 1, maxCalls: 5, tokens: 10_000_000, maxTokens: 0 })).toBe(false);
  });
});

describe("roster payload", () => {
  test("match.created carries each seat's configured thinking strength", () => {
    const state = buildState([1, 1]);
    const [first, second] = state.participants;
    const seeded: MatchState = {
      ...state,
      participants: [
        { ...first, model: { ...first.model, supportsReasoning: true, reasoningEffort: "high" } },
        second,
      ],
    };

    const { effects } = reduce(seeded, { kind: "start", at: 1 });
    const created = effects.find((e) => e.kind === "emit" && e.event.type === "match.created");
    if (!created || created.kind !== "emit") throw new Error("match.created missing");

    const teams = created.event.payload.teams as Array<{ members: Array<{ reasoning: string | null }> }>;
    expect(teams[0].members[0].reasoning).toBe("high");
    expect(teams[1].members[0].reasoning).toBeNull();
  });
});

describe("seat payloads", () => {
  test("seat.submitted carries usage and latency so the seat card can show them", () => {
    let state = buildState([1, 1]);
    state = reduce(state, { kind: "start", at: 0 }).state;

    const { effects } = reduce(state, {
      kind: "submit",
      submission: {
        participantId: "part-0",
        seat: 0,
        status: "ready",
        thinking: "想一想",
        content: { bid: 7, line: "x" },
        raw: "",
        usage: { promptTokens: 12, completionTokens: 34 },
        latencyMs: 56,
        anomalies: [],
      },
    });

    const submitted = effects.find((e) => e.kind === "emit" && e.event.type === "seat.submitted");
    if (!submitted || submitted.kind !== "emit") throw new Error("seat.submitted missing");
    expect(submitted.event.payload.usage).toEqual({ promptTokens: 12, completionTokens: 34 });
    expect(submitted.event.payload.latencyMs).toBe(56);
  });
});
