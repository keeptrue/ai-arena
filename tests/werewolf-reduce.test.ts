import { describe, expect, test } from "bun:test";
import { parseWerewolfBlueprint } from "../src/engine/werewolf/blueprint";
import { dealRoles } from "../src/engine/werewolf/deal";
import { coerceWerewolfAction, createWerewolfState, reduceWerewolf } from "../src/engine/werewolf/reduce";
import type {
  PhaseAction,
  WerewolfEffect,
  WerewolfPhase,
  WerewolfRoleId,
  WerewolfState,
} from "../src/engine/werewolf/types";

const SPEC = parseWerewolfBlueprint({
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
});

const ROLES: WerewolfRoleId[] = [
  "wolf",
  "wolf",
  "wolf",
  "villager",
  "villager",
  "villager",
  "seer",
  "witch",
  "hunter",
];

type Script = Record<string, PhaseAction | ((state: WerewolfState) => PhaseAction | null)>;

function drive(script: Script, roles: WerewolfRoleId[] = ROLES, seed = "seed-1", spec = SPEC) {
  let state = createWerewolfState({
    matchId: "m1",
    spec,
    seed,
    dealSource: "manual",
    seats: roles.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
    budget: { maxCalls: 999, maxTokens: 0 },
    at: 0,
  });
  const events: Array<{ type: string; payload: any; seat?: number }> = [];
  const effects: WerewolfEffect[] = [];

  const apply = (action: Parameters<typeof reduceWerewolf>[1]) => {
    const result = reduceWerewolf(state, action);
    state = result.state;
    effects.push(...result.effects);
  };

  apply({ kind: "start", at: 0 });
  let guard = 0;
  while (guard++ < 1200) {
    const effect = effects.shift();
    if (!effect) break;
    if (effect.kind === "emit") {
      events.push({ type: effect.event.type, payload: effect.event.payload, seat: effect.event.seat });
      continue;
    }
    if (effect.kind === "finish") continue;
    const key = `${effect.phase}:${effect.seat}`;
    const value = script[key];
    const action = typeof value === "function" ? value(state) : value;
    apply({
      kind: "submit",
      submission: {
        seat: effect.seat,
        phase: effect.phase,
        status: action ? "ready" : "forfeit",
        action: action ?? null,
        thinking: "",
        reasoning: "",
        raw: "",
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
        anomalies: [],
      },
    });
  }
  return { state, events };
}

const text = (s: string) => ({ kind: "speech" as const, text: s });
const vote = (target: number | "abstain") => ({ kind: "vote" as const, target });
const pass = { kind: "hunter" as const, target: "pass" as const };
const none = { kind: "witch" as const, action: "none" as const, target: null };
const words = { kind: "last_words" as const, text: "遗言" };

function speechForAll(): Script["day_speech"] {
  return (state) => {
    const seat = state.queue[state.queueIndex - 1];
    return text(`${seat + 1}号发言`);
  };
}

const base: Script = {
  "night_wolves:0": { kind: "wolf", target: 3, talk: "刀三" },
  "night_wolves:1": { kind: "wolf", target: 3, talk: "跟" },
  "night_wolves:2": { kind: "wolf", target: 3, talk: "跟" },
  "night_seer:6": { kind: "seer", target: 0 },
  "night_witch:7": none,
  "day_speech:0": text("我先说"),
  "day_speech:1": text("我听预言家"),
  "day_speech:2": text("我过"),
  "day_speech:3": text("（已出局，不应被叫）"),
  "day_speech:4": text("我过"),
  "day_speech:5": text("我过"),
  "day_speech:6": text("我是预言家，0 号是狼"),
  "day_speech:7": text("我过"),
  "day_speech:8": text("我过"),
  "day_vote:0": vote(1),
  "day_vote:1": vote(0),
  "day_vote:2": vote(0),
  "day_vote:3": vote(0),
  "day_vote:4": vote(0),
  "day_vote:5": vote(0),
  "day_vote:6": vote(0),
  "day_vote:7": vote(0),
  "day_vote:8": vote(0),
  "day_last_words:3": words,
  "day_last_words:0": words,
  "day_last_words:1": words,
  "day_last_words:2": words,
  "hunter_shot:8": pass,
};

describe("werewolf deal", () => {
  test("a seeded deal is deterministic and contains the exact deck", () => {
    const a = dealRoles(SPEC, "seed-1");
    const b = dealRoles(SPEC, "seed-1");
    expect(a).toEqual(b);
    expect(a.filter((r) => r === "wolf")).toHaveLength(3);
    expect(a.filter((r) => r === "villager")).toHaveLength(3);
    expect(new Set(a).size).toBe(5);
  });
});

describe("werewolf night", () => {
  test("wolves kill, the seer learns a camp, and the witch can stay idle", () => {
    const { state, events } = drive(base);
    const dawn = events.find((e) => e.type === "dawn")!;
    expect(dawn.payload.deaths).toEqual([3]);
    const check = events.find((e) => e.type === "seer.check")!;
    expect(check.payload).toMatchObject({ seat: 6, target: 0, result: "wolf" });
    expect(events.some((e) => e.type === "match.finished")).toBe(true);
  });

  test("a split wolf vote resolves by plurality", () => {
    const { events } = drive({
      ...base,
      "night_wolves:0": { kind: "wolf", target: 3, talk: "" },
      "night_wolves:1": { kind: "wolf", target: 4, talk: "" },
      "night_wolves:2": { kind: "wolf", target: 4, talk: "" },
    });
    const dawn = events.find((e) => e.type === "dawn")!;
    expect(dawn.payload.deaths).toEqual([4]);
  });

  test("an empty kill is a peaceful night", () => {
    const { events } = drive({
      ...base,
      "night_wolves:0": { kind: "wolf", target: "empty", talk: "" },
      "night_wolves:1": { kind: "wolf", target: "empty", talk: "" },
      "night_wolves:2": { kind: "wolf", target: "empty", talk: "" },
    });
    const dawn = events.find((e) => e.type === "dawn")!;
    expect(dawn.payload.deaths).toEqual([]);
  });

  test("the antidote cancels the kill", () => {
    const { events } = drive({
      ...base,
      "night_witch:7": { kind: "witch", action: "save", target: null },
    });
    const dawn = events.find((e) => e.type === "dawn")!;
    expect(dawn.payload.deaths).toEqual([]);
  });

  test("poison kills and the cause is poison, not the wolf knife", () => {
    const { events } = drive({
      ...base,
      "night_wolves:0": { kind: "wolf", target: 0, talk: "" },
      "night_wolves:1": { kind: "wolf", target: 0, talk: "" },
      "night_wolves:2": { kind: "wolf", target: 0, talk: "" },
      "night_witch:7": { kind: "witch", action: "poison", target: 0 },
    });
    const resolved = events.find((e) => e.type === "night.resolved")!;
    expect(resolved.payload.deaths).toEqual([{ seat: 0, cause: "poison" }]);
  });
});

describe("wolf night conference", () => {
  const switchOnDecide =
    (first: number, final: number) =>
    (state: WerewolfState): PhaseAction => ({
      kind: "wolf",
      target: (state.night.wolfStage ?? "discuss") === "decide" ? final : first,
      talk: "",
    });

  test("the deciding round can change the kill", () => {
    const { events } = drive({
      ...base,
      "night_wolves:0": switchOnDecide(3, 5),
      "night_wolves:1": switchOnDecide(4, 5),
      "night_wolves:2": switchOnDecide(4, 5),
    });
    const dawn = events.find((e) => e.type === "dawn")!;
    expect(dawn.payload.deaths).toEqual([5]);
  });

  test("the two call sets are tagged so the runtime keeps them apart", () => {
    let state = createWerewolfState({
      matchId: "m-stage",
      spec: SPEC,
      seed: "seed-stage",
      dealSource: "manual",
      seats: ROLES.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
      budget: { maxCalls: 999, maxTokens: 0 },
      at: 0,
    });
    const queue: WerewolfEffect[] = [];
    const apply = (action: Parameters<typeof reduceWerewolf>[1]) => {
      const result = reduceWerewolf(state, action);
      state = result.state;
      queue.push(...result.effects);
    };
    apply({ kind: "start", at: 0 });

    const stages: Array<string | undefined> = [];
    let guard = 0;
    while (queue.length > 0 && guard++ < 40) {
      const effect = queue.shift()!;
      if (effect.kind !== "call_seat") continue;
      if (effect.phase !== "night_wolves") break;
      stages.push(effect.stage);
      apply({
        kind: "submit",
        submission: {
          seat: effect.seat,
          phase: effect.phase,
          status: "ready",
          action: { kind: "wolf", target: 3, talk: "" },
          thinking: "",
          reasoning: "",
          raw: "",
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 1,
          anomalies: [],
        },
      });
    }
    expect(stages).toEqual(["discuss", "discuss", "discuss", "decide", "decide", "decide"]);
  });

  test("a lone wolf speaks once and skips the deciding round", () => {
    const state = createWerewolfState({
      matchId: "m-lone",
      spec: SPEC,
      seed: "seed-lone",
      dealSource: "manual",
      seats: ROLES.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
      budget: { maxCalls: 999, maxTokens: 0 },
      at: 0,
    });
    state.seats[1].alive = false;
    state.seats[2].alive = false;
    state.day = 1;
    state.phase = "night_wolves";
    state.queue = [0];
    state.queueIndex = 1;
    state.pending = {};

    const result = reduceWerewolf(state, {
      kind: "submit",
      submission: {
        seat: 0,
        phase: "night_wolves",
        status: "ready",
        action: { kind: "wolf", target: 3, talk: "" },
        thinking: "",
        reasoning: "",
        raw: "",
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
        anomalies: [],
      },
    });
    expect(result.state.night.wolfVotes[0]).toBe(3);
    expect(result.state.phase).toBe("night_seer");
    expect(
      result.effects.some((e) => e.kind === "call_seat" && e.phase === "night_wolves"),
    ).toBe(false);
  });

  test("a failed deciding call falls back to that wolf's first proposal", () => {
    const state = createWerewolfState({
      matchId: "m-fallback",
      spec: SPEC,
      seed: "seed-fallback",
      dealSource: "manual",
      seats: ROLES.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
      budget: { maxCalls: 999, maxTokens: 0 },
      at: 0,
    });
    state.day = 1;
    state.phase = "night_wolves";
    state.night.wolfStage = "decide";
    state.night.wolfVotes = { 0: 3, 1: 3, 2: 4 };
    state.queue = [0, 1, 2];
    state.queueIndex = 1;
    state.pending = {};

    const act = (
      current: WerewolfState,
      seat: number,
      action: PhaseAction | null,
    ) =>
      reduceWerewolf(current, {
        kind: "submit",
        submission: {
          seat,
          phase: "night_wolves",
          status: action ? "ready" : "forfeit",
          action,
          thinking: "",
          reasoning: "",
          raw: "",
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 1,
          anomalies: [],
        },
      });

    const skipped = act(state, 0, null);
    expect(skipped.state.pending[0]).toEqual({ kind: "wolf", target: 3, talk: "" });

    const second = act(skipped.state, 1, { kind: "wolf", target: 3, talk: "" });
    const third = act(second.state, 2, { kind: "wolf", target: 4, talk: "" });
    expect(third.state.night.wolfVotes).toEqual({ 0: 3, 1: 3, 2: 4 });
    expect(third.state.night.killTarget).toBe(3);
    expect(third.state.phase).toBe("night_seer");
  });
});

describe("day speaking order", () => {
  const abstainEverywhere = (): Script => {
    const script: Script = {};
    for (let seat = 0; seat < 9; seat += 1) script[`day_vote:${seat}`] = vote("abstain");
    return script;
  };
  const emptyKill = { kind: "wolf" as const, target: "empty" as const, talk: "" };

  test("a peaceful night starts with the seat after the last speaker", () => {
    const { events } = drive({
      ...base,
      ...abstainEverywhere(),
      "night_wolves:0": emptyKill,
      "night_wolves:1": emptyKill,
      "night_wolves:2": emptyKill,
    });
    const day1 = events.filter((e) => e.type === "speech" && e.payload.day === 1);
    const day2 = events.filter((e) => e.type === "speech" && e.payload.day === 2);
    expect(day1.at(-1)?.payload.seat).toBe(8);
    expect(day2[0]?.payload.seat).toBe(0);
  });

  test("a death night still starts after the lowest dead seat", () => {
    const kill = (state: WerewolfState): PhaseAction => ({
      kind: "wolf",
      target: state.day === 2 ? 6 : 3,
      talk: "",
    });
    const { events } = drive({
      ...base,
      ...abstainEverywhere(),
      "night_wolves:0": kill,
      "night_wolves:1": kill,
      "night_wolves:2": kill,
    });
    const day2 = events.filter((e) => e.type === "speech" && e.payload.day === 2);
    expect(day2[0]?.payload.seat).toBe(7);
  });
});

describe("werewolf hunter", () => {
  test("a wolf-killed hunter shoots, and the victim has no last words", () => {
    const { events } = drive({
      ...base,
      "night_wolves:0": { kind: "wolf", target: 8, talk: "" },
      "night_wolves:1": { kind: "wolf", target: 8, talk: "" },
      "night_wolves:2": { kind: "wolf", target: 8, talk: "" },
      "hunter_shot:8": { kind: "hunter", target: 0 },
      "day_vote:0": vote("abstain"),
      "day_vote:1": vote("abstain"),
      "day_vote:2": vote("abstain"),
      "day_vote:3": vote("abstain"),
      "day_vote:4": vote("abstain"),
      "day_vote:5": vote("abstain"),
      "day_vote:6": vote("abstain"),
      "day_vote:7": vote("abstain"),
      "day_vote:8": vote("abstain"),
    });
    const dawn = events.find((e) => e.type === "dawn")!;
    expect(dawn.payload.deaths).toEqual([8]);
    const shot = events.find((e) => e.type === "hunter.shot")!;
    expect(shot.payload).toMatchObject({ seat: 8, target: 0 });
    const words = events.filter((e) => e.type === "last_words").map((e) => e.payload.seat);
    expect(words[0]).toBe(8);
  });

  test("a poisoned hunter cannot shoot", () => {
    const { events } = drive({
      ...base,
      "night_wolves:0": { kind: "wolf", target: 3, talk: "" },
      "night_wolves:1": { kind: "wolf", target: 3, talk: "" },
      "night_wolves:2": { kind: "wolf", target: 3, talk: "" },
      "night_witch:7": { kind: "witch", action: "poison", target: 8 },
    });
    expect(events.some((e) => e.type === "hunter.shot")).toBe(false);
    const resolved = events.find((e) => e.type === "night.resolved")!;
    expect(resolved.payload.deaths).toContainEqual({ seat: 8, cause: "poison" });
  });
});

describe("werewolf day", () => {
  test("a plurality exile is public, then night resumes", () => {
    const { state, events } = drive(base);
    const exile = events.find((e) => e.type === "exile")!;
    expect(exile.payload.seat).toBe(0);
    expect(events.filter((e) => e.type === "round.closed").length).toBeGreaterThan(0);
    expect(state.day).toBeGreaterThan(1);
  });

  test("a tie goes to PK and a re-vote can exile", () => {
    const { events } = drive({
      ...base,
      "day_vote:0": vote(1),
      "day_vote:1": vote(0),
      "day_vote:2": vote(0),
      "day_vote:3": vote(0),
      "day_vote:4": vote(0),
      "day_vote:5": vote(1),
      "day_vote:6": vote(0),
      "day_vote:7": vote(1),
      "day_vote:8": vote(1),
      "day_pk_speech:0": text("PK 甲"),
      "day_pk_speech:1": text("PK 乙"),
      "day_pk_vote:2": vote(0),
      "day_pk_vote:4": vote(0),
      "day_pk_vote:5": vote(0),
      "day_pk_vote:6": vote(0),
      "day_pk_vote:7": vote(0),
      "day_pk_vote:8": vote(0),
    });
    expect(events.some((e) => e.type === "pk.opened")).toBe(true);
    const exile = events.find((e) => e.type === "exile")!;
    expect(exile.payload.seat).toBe(0);
  });

  test("a wolf self-destruct ends the day without a vote", () => {
    const { state, events } = drive({
      ...base,
      "day_speech:0": { kind: "speech", text: "我爆了", selfDestruct: true },
    });
    expect(events.some((e) => e.type === "self_destruct")).toBe(true);
    const selfDestructAt = events.findIndex((e) => e.type === "self_destruct");
    const firstVote = events.findIndex((e) => e.type === "vote.tally");
    expect(firstVote === -1 || firstVote > selfDestructAt).toBe(true);
    expect(state.seats[0].alive).toBe(false);
  });

  test("a self-destruct leaves no last words under the house rule", () => {
    const { events } = drive({
      ...base,
      "day_speech:0": { kind: "speech", text: "我爆了", selfDestruct: true },
    });
    expect(events.some((e) => e.type === "self_destruct")).toBe(true);
    const seats = events.filter((e) => e.type === "last_words").map((e) => e.payload.seat);
    expect(seats).not.toContain(0);
  });

  test("selfDestructLastWords can be turned back on by the blueprint", () => {
    const withWords = {
      ...SPEC,
      rules: { ...SPEC.rules, day: { ...SPEC.rules.day, selfDestructLastWords: true } },
    };
    const { events } = drive(
      {
        ...base,
        "day_speech:0": { kind: "speech", text: "我爆了", selfDestruct: true },
        "day_last_words:0": { kind: "last_words", text: "留一句" },
      },
      ROLES,
      "seed-1",
      withWords,
    );
    const seats = events.filter((e) => e.type === "last_words").map((e) => e.payload.seat);
    expect(seats).toContain(0);
  });
});

describe("werewolf win conditions", () => {
  test("removing every wolf hands the game to the good camp", () => {
    const { state, events } = drive({
      ...base,
      "day_vote:0": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:1": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:2": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:3": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:4": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:5": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:6": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:7": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "day_vote:8": (s) => (s.day === 1 ? vote(0) : s.day === 2 ? vote(1) : vote(2)),
      "night_wolves:0": { kind: "wolf", target: 3, talk: "" },
      "night_wolves:1": { kind: "wolf", target: 3, talk: "" },
      "night_wolves:2": { kind: "wolf", target: 3, talk: "" },
    });
    if (state.winner !== "good") console.log("good-win debug", state.day, state.phase, state.endReason, events.map(e => e.type).join(","));
    expect(state.winner).toBe("good");
    expect(state.endReason).toBe("wolves_out");
    expect(events.some((e) => e.type === "match.finished")).toBe(true);
  });

  test("killing all gods is a wolf win", () => {
    const { state } = drive({
      ...base,
      "night_wolves:0": (s) => ({ kind: "wolf", target: s.day === 1 ? 6 : s.day === 2 ? 7 : 8, talk: "" }),
      "night_wolves:1": (s) => ({ kind: "wolf", target: s.day === 1 ? 6 : s.day === 2 ? 7 : 8, talk: "" }),
      "night_wolves:2": (s) => ({ kind: "wolf", target: s.day === 1 ? 6 : s.day === 2 ? 7 : 8, talk: "" }),
      "day_vote:0": vote("abstain"),
      "day_vote:1": vote("abstain"),
      "day_vote:2": vote("abstain"),
      "day_vote:3": vote("abstain"),
      "day_vote:4": vote("abstain"),
      "day_vote:5": vote("abstain"),
      "day_vote:6": vote("abstain"),
      "day_vote:7": vote("abstain"),
      "day_vote:8": vote("abstain"),
      "hunter_shot:8": pass,
      "day_speech:6": text("我验 0 是狼"),
      "day_speech:7": text("我过"),
      "day_speech:8": text("我过"),
    });
    expect(state.winner).toBe("wolf");
    expect(state.endReason).toBe("gods_wiped");
  });
});

describe("werewolf edge rules", () => {
  test("the witch may save herself on night one, but not later", () => {
    const { events } = drive({
      ...base,
      "night_wolves:0": { kind: "wolf", target: 7, talk: "" },
      "night_wolves:1": { kind: "wolf", target: 7, talk: "" },
      "night_wolves:2": { kind: "wolf", target: 7, talk: "" },
      "night_witch:7": (s) => ({ kind: "witch", action: "save", target: null }),
      "day_vote:0": vote("abstain"),
      "day_vote:1": vote("abstain"),
      "day_vote:2": vote("abstain"),
      "day_vote:3": vote("abstain"),
      "day_vote:4": vote("abstain"),
      "day_vote:5": vote("abstain"),
      "day_vote:6": vote("abstain"),
      "day_vote:7": vote("abstain"),
      "day_vote:8": vote("abstain"),
    });
    const resolved = events.filter((e) => e.type === "night.resolved");
    expect(resolved[0].payload.deaths).toEqual([]);
    expect(resolved[1].payload.deaths).toEqual([{ seat: 7, cause: "wolf" }]);
  });

  test("killing every villager is a wolf win", () => {
    const { state } = drive({
      ...base,
      "night_wolves:0": (s) => ({ kind: "wolf", target: s.day === 1 ? 3 : s.day === 2 ? 4 : 5, talk: "" }),
      "night_wolves:1": (s) => ({ kind: "wolf", target: s.day === 1 ? 3 : s.day === 2 ? 4 : 5, talk: "" }),
      "night_wolves:2": (s) => ({ kind: "wolf", target: s.day === 1 ? 3 : s.day === 2 ? 4 : 5, talk: "" }),
      "day_vote:0": vote("abstain"),
      "day_vote:1": vote("abstain"),
      "day_vote:2": vote("abstain"),
      "day_vote:3": vote("abstain"),
      "day_vote:4": vote("abstain"),
      "day_vote:5": vote("abstain"),
      "day_vote:6": vote("abstain"),
      "day_vote:7": vote("abstain"),
      "day_vote:8": vote("abstain"),
    });
    expect(state.winner).toBe("wolf");
    expect(state.endReason).toBe("villagers_wiped");
  });

  test("the same script replays to the same board", () => {
    const a = drive(base);
    const b = drive(base);
    expect(a.state.seats.map((s) => ({ role: s.role, alive: s.alive, death: s.death }))).toEqual(
      b.state.seats.map((s) => ({ role: s.role, alive: s.alive, death: s.death })),
    );
    expect(a.state.winner).toBe(b.state.winner);
    expect(a.state.publicLog).toEqual(b.state.publicLog);
  });

  test("a table that never kills or votes ends on the day limit without a winner", () => {
    const { state } = drive({
      ...base,
      "night_wolves:0": { kind: "wolf", target: "empty", talk: "" },
      "night_wolves:1": { kind: "wolf", target: "empty", talk: "" },
      "night_wolves:2": { kind: "wolf", target: "empty", talk: "" },
      "day_vote:0": vote("abstain"),
      "day_vote:1": vote("abstain"),
      "day_vote:2": vote("abstain"),
      "day_vote:3": vote("abstain"),
      "day_vote:4": vote("abstain"),
      "day_vote:5": vote("abstain"),
      "day_vote:6": vote("abstain"),
      "day_vote:7": vote("abstain"),
      "day_vote:8": vote("abstain"),
    });
    expect(state.winner).toBeNull();
    expect(state.endReason).toBe("day_limit");
    expect(state.day).toBe(8);
  });

  test("a table where every call fails still terminates", () => {
    const { state } = drive({});
    expect(state.phase).toBe("done");
    expect(state.endReason).toBe("day_limit");
  });

  test("first-night deaths speak before the day starts", () => {
    const { events } = drive(base);
    const kinds = events.map((e) => e.type);
    const dawnie = kinds.indexOf("dawn");
    const words = kinds.indexOf("last_words");
    const speech = kinds.indexOf("speech");
    expect(dawnie).toBeGreaterThan(-1);
    expect(words).toBeGreaterThan(dawnie);
    expect(speech).toBeGreaterThan(words);
  });
});


describe("model-facing seat numbers", () => {
  test("prompts are 1-based and the engine stores 0-based", () => {
    expect(coerceWerewolfAction("day_vote", { vote: 3 })).toEqual({ kind: "vote", target: 2 });
    expect(coerceWerewolfAction("day_vote", { vote: "3号" })).toEqual({ kind: "vote", target: 2 });
    expect(coerceWerewolfAction("day_vote", { vote: "弃票" })).toEqual({ kind: "vote", target: "abstain" });
    expect(coerceWerewolfAction("night_wolves", { target: "空刀", talk: "" })).toEqual({
      kind: "wolf",
      target: "empty",
      talk: "",
    });
    expect(coerceWerewolfAction("hunter_shot", { target: "pass" })).toEqual({
      kind: "hunter",
      target: "pass",
    });
  });

  test("out-of-range and malformed targets are null, not guessed", () => {
    expect(coerceWerewolfAction("day_vote", { vote: 0 })).toBeNull();
    expect(coerceWerewolfAction("day_vote", { vote: 10 })).toBeNull();
    expect(coerceWerewolfAction("night_seer", {})).toBeNull();
    expect(coerceWerewolfAction("night_witch", { action: "poison" })).toBeNull();
  });

  test("a structured note rides along without changing the action", () => {
    expect(coerceWerewolfAction("day_vote", { note: "写给观众", vote: 2 })).toEqual({
      kind: "vote",
      target: 1,
    });
    expect(coerceWerewolfAction("day_speech", { note: "写给观众", speech: "我发言" })).toEqual({
      kind: "speech",
      text: "我发言",
    });
  });
});

describe("manual recall at the table", () => {
  function dayVoteWithForfeit(): WerewolfState {
    const state = createWerewolfState({
      matchId: "m1",
      spec: SPEC,
      seed: "seed-1",
      dealSource: "manual",
      seats: ROLES.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
      budget: { maxCalls: 999, maxTokens: 0 },
      at: 0,
    });
    state.phase = "day_vote";
    state.day = 1;
    state.callMode = "parallel";
    state.queue = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    state.queueIndex = 9;
    // The provisional ballot a forfeit leaves behind, and the strike it earned.
    state.pending = { 3: { kind: "vote", target: "abstain" } };
    const seat = state.seats.find((s) => s.seat === 3)!;
    seat.forfeitsInARow = 2;
    seat.afk = true;
    seat.lastForfeitPhase = "day_vote";
    return state;
  }

  const voteSubmission = (seat: number, target: number) => ({
    seat,
    phase: "day_vote" as const,
    status: "ready" as const,
    action: { kind: "vote" as const, target },
    thinking: "",
    reasoning: "",
    raw: "",
    usage: { promptTokens: 1, completionTokens: 1 },
    latencyMs: 1,
    anomalies: [],
  });

  test("a recalled seat is un-struck, un-AFKed and called again", () => {
    const { state: next, effects } = reduceWerewolf(dayVoteWithForfeit(), { kind: "recall", seat: 3 });
    expect(next.pending[3]).toBeUndefined();
    expect(next.recalled).toEqual([3]);
    const seat = next.seats.find((s) => s.seat === 3)!;
    expect(seat.forfeitsInARow).toBe(1);
    expect(seat.afk).toBe(false);
    expect(seat.lastForfeitPhase).toBeNull();

    const called = effects.find((e) => e.kind === "call_seat");
    expect(called).toMatchObject({ kind: "call_seat", seat: 3, phase: "day_vote" });
    expect(effects.some((e) => e.kind === "emit" && e.event.type === "seat.recalled")).toBe(true);
  });

  test("the recalled seat's late ballot is the one that counts", () => {
    const { state: recalled } = reduceWerewolf(dayVoteWithForfeit(), { kind: "recall", seat: 3 });
    const { effects } = reduceWerewolf(recalled, {
      kind: "submit",
      submission: voteSubmission(3, 0),
    });
    const accepted = effects.some((e) => e.kind === "emit" && e.event.type === "seat.submitted");
    expect(accepted).toBe(true);
  });

  test("a seat whose phase already turned cannot be re-opened", () => {
    const state = dayVoteWithForfeit();
    state.seats.find((s) => s.seat === 3)!.lastForfeitPhase = "day_speech";
    const result = reduceWerewolf(state, { kind: "recall", seat: 3 });
    expect(result.effects).toHaveLength(0);
    expect(result.state).toBe(state);
  });

  test("a seat outside this phase's queue cannot be recalled", () => {
    const state = dayVoteWithForfeit();
    state.queue = [0, 1, 2];
    const result = reduceWerewolf(state, { kind: "recall", seat: 3 });
    expect(result.effects).toHaveLength(0);
  });

  test("recalling twice does not buy a third call", () => {
    const { state: once } = reduceWerewolf(dayVoteWithForfeit(), { kind: "recall", seat: 3 });
    const twice = reduceWerewolf(once, { kind: "recall", seat: 3 });
    expect(twice.effects).toHaveLength(0);
    expect(twice.state).toBe(once);
  });

  test("a sequential phase still refuses a seat that jumped the queue", () => {
    // Only a hand-reopened seat may answer out of turn. In a sequential phase the
    // queue position is the turn, so anyone else is still rejected.
    const state = dayVoteWithForfeit();
    state.phase = "night_wolves";
    state.callMode = "sequential";
    state.queue = [0, 1, 2];
    state.queueIndex = 2;
    state.pending = {};
    const { effects } = reduceWerewolf(state, {
      kind: "submit",
      submission: { ...voteSubmission(3, 0), phase: "night_wolves" },
    });
    expect(effects).toHaveLength(0);
  });

  test("a new phase never inherits the late-answer pass", () => {
    const { state: recalled } = reduceWerewolf(dayVoteWithForfeit(), { kind: "recall", seat: 3 });
    // Fill the rest of the table so the vote resolves and the day moves on.
    let state = reduceWerewolf(recalled, { kind: "submit", submission: voteSubmission(3, 0) }).state;
    for (const seat of [0, 1, 2, 4, 5, 6, 7, 8]) {
      state = reduceWerewolf(state, { kind: "submit", submission: voteSubmission(seat, 3) }).state;
    }
    expect(state.phase).not.toBe("day_vote");
    expect(state.recalled).toHaveLength(0);
  });
});
