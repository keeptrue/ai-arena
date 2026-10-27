import { describe, expect, test } from "bun:test";
import { parseBlueprint } from "../src/engine/blueprint";
import { createMatchState, recoverRound, reduce } from "../src/engine/round";
import type {
  Blueprint,
  MatchState,
  ModelSnapshot,
  ParticipantState,
  Submission,
  TeamState,
} from "../src/engine/types";

const BP: Blueprint = parseBlueprint({
  id: "td-recover",
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

function buildState(teamSizes: number[] = [2, 2]): MatchState {
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
    matchId: "match-recover",
    rulesetId: "rs",
    blueprint: BP,
    seed: "seed-1",
    teams,
    participants,
    judgeModel: model(0),
    budget: { maxCalls: 1000, maxTokens: 0 },
    at: 0,
  });
}

function submissionFor(p: ParticipantState, round: number): Submission {
  return {
    participantId: p.id,
    seat: p.seat,
    status: "ready",
    thinking: `${p.id} 第${round}轮推演`,
    content: { bid: 100 + p.seat, line: `${p.id} 的话` },
    raw: "",
    usage: { promptTokens: 10, completionTokens: 10 },
    latencyMs: 1,
    anomalies: [],
  };
}

function started(): MatchState {
  const state = buildState();
  return reduce(state, { kind: "start", at: 0 }).state;
}

describe("rubric recovery", () => {
  test("collecting: only the participants who never answered are called again", () => {
    const state = started();
    const [first] = state.participants;
    const after = reduce(state, { kind: "submit", submission: submissionFor(first, 1) }).state;
    expect(after.phase).toBe("collecting");

    const { effects } = recoverRound(after);
    expect(effects).toHaveLength(1);
    const effect = effects[0];
    expect(effect.kind).toBe("call_participants");
    if (effect.kind !== "call_participants") throw new Error("unreachable");
    expect(effect.ids).toEqual(["part-1", "part-2", "part-3"]);
  });

  test("judging: the judge is asked again for the same round", () => {
    let state = started();
    for (const p of state.participants) {
      state = reduce(state, { kind: "submit", submission: submissionFor(p, 1) }).state;
    }
    expect(state.phase).toBe("judging");

    const { effects } = recoverRound(state);
    expect(effects).toHaveLength(1);
    const effect = effects[0];
    expect(effect.kind).toBe("call_judge");
    if (effect.kind !== "call_judge") throw new Error("unreachable");
    expect(effect.round).toBe(1);
    expect(effect.sudden).toBe(false);
  });

  test("a round that is fully in but never advanced asks the judge, not the seats", () => {
    let state = started();
    for (const p of state.participants) {
      state = reduce(state, { kind: "submit", submission: submissionFor(p, 1) }).state;
    }
    // The last submit died between the reducer flipping to `judging` and the call.
    const stuck: MatchState = { ...state, phase: "collecting" };

    const { effects } = recoverRound(stuck);
    expect(effects.map((e) => e.kind)).toEqual(["call_judge"]);
  });

  test("a finished match has nothing to recover", () => {
    const state: MatchState = { ...started(), phase: "done" };
    expect(recoverRound(state).effects).toHaveLength(0);
  });
});

describe("manual recall", () => {
  function forfeited(): { state: MatchState; id: string; teamId: string } {
    const state = started();
    const [first] = state.participants;
    const after = reduce(state, {
      kind: "submit",
      submission: {
        ...submissionFor(first, 1),
        status: "forfeit",
        content: {},
        anomalies: ["stream_stalled: 180 秒没有新内容，已中止"],
      },
    }).state;
    return { state: after, id: first.id, teamId: first.teamId };
  }

  test("a recalled seat is owed again and its strike is refunded", () => {
    const { state, id, teamId } = forfeited();
    expect(state.teams.find((t) => t.id === teamId)?.forfeits).toBe(1);

    const { state: next, effects } = reduce(state, { kind: "recall", participantId: id });
    expect(next.pending[id]).toBeUndefined();
    expect(next.participants.find((p) => p.id === id)?.status).toBe("idle");
    // A false cut must not bring a team closer to the two-strike disqualification.
    expect(next.teams.find((t) => t.id === teamId)?.forfeits).toBe(0);

    const called = effects.find((e) => e.kind === "call_participants");
    expect(called).toMatchObject({ kind: "call_participants", ids: [id] });
    const announced = effects.some((e) => e.kind === "emit" && e.event.type === "seat.recalled");
    expect(announced).toBe(true);
  });

  test("recovery treats the recalled seat as still owing a turn", () => {
    const { state, id } = forfeited();
    const { state: next } = reduce(state, { kind: "recall", participantId: id });
    const { effects } = recoverRound(next);
    const effect = effects[0];
    expect(effect.kind).toBe("call_participants");
    if (effect.kind !== "call_participants") throw new Error("unreachable");
    expect(effect.ids).toContain(id);
  });

  test("a judged round cannot be rewound", () => {
    const { state, id } = forfeited();
    let judged = state;
    for (const p of judged.participants) {
      if (judged.pending[p.id]) continue;
      judged = reduce(judged, { kind: "submit", submission: submissionFor(p, 1) }).state;
    }
    expect(judged.phase).toBe("judging");

    const result = reduce(judged, { kind: "recall", participantId: id });
    expect(result.effects).toHaveLength(0);
    expect(result.state).toBe(judged);
  });

  test("a seat that actually answered is not recallable", () => {
    const state = started();
    const [first] = state.participants;
    const answered = reduce(state, { kind: "submit", submission: submissionFor(first, 1) }).state;
    const result = reduce(answered, { kind: "recall", participantId: first.id });
    expect(result.effects).toHaveLength(0);
    expect(result.state).toBe(answered);
  });
});
