import { describe, expect, test } from "bun:test";
import { parseWerewolfBlueprint } from "../src/engine/werewolf/blueprint";
import {
  createWerewolfState,
  recoverWerewolf,
  reduceWerewolf,
} from "../src/engine/werewolf/reduce";
import type {
  PhaseAction,
  WerewolfEffect,
  WerewolfPhase,
  WerewolfRoleId,
  WerewolfState,
} from "../src/engine/werewolf/types";

const SPEC = parseWerewolfBlueprint({
  mode: "werewolf",
  id: "ww-recover",
  name: "预女猎九人局",
  tagline: "断点续跑",
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

function newState(): WerewolfState {
  return createWerewolfState({
    matchId: "m-recover",
    spec: SPEC,
    seed: "seed-recover",
    dealSource: "manual",
    seats: ROLES.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
    budget: { maxCalls: 999, maxTokens: 0 },
    at: 0,
  });
}

function submission(seat: number, phase: WerewolfPhase, action: PhaseAction) {
  return {
    seat,
    phase,
    status: "ready" as const,
    action,
    thinking: "",
    reasoning: "",
    raw: "",
    usage: { promptTokens: 1, completionTokens: 1 },
    latencyMs: 1,
    anomalies: [],
  };
}

/** Every role plays the most boring legal move, so the game walks forward unattended. */
function autoAction(seat: number, phase: WerewolfPhase): PhaseAction {
  switch (phase) {
    case "night_wolves":
      return { kind: "wolf", target: 3, talk: "" };
    case "night_seer":
      return { kind: "seer", target: 0 };
    case "night_witch":
      return { kind: "witch", action: "none", target: null };
    case "day_speech":
    case "day_pk_speech":
      return { kind: "speech", text: `${seat + 1}号过麦` };
    case "day_vote":
    case "day_pk_vote":
      return { kind: "vote", target: "abstain" };
    case "hunter_shot":
      return { kind: "hunter", target: "pass" };
    case "day_last_words":
      return { kind: "last_words", text: "遗言" };
    default:
      return { kind: "speech", text: "" };
  }
}

/**
 * Play until `target` is entered, then answer only `answerIn` of its calls and
 * drop the rest — exactly the shape a killed process leaves behind.
 */
function playTo(target: WerewolfPhase, answerIn: number): WerewolfState {
  let state = newState();
  const started = reduceWerewolf(state, { kind: "start", at: 0 });
  state = started.state;
  const queue: WerewolfEffect[] = [...started.effects];

  let answered = 0;
  let guard = 0;
  while (queue.length > 0 && guard++ < 800) {
    const effect = queue.shift()!;
    if (effect.kind !== "call_seat") continue;
    if (effect.phase === target && answered >= answerIn) continue; // the crash: call issued, never answered
    const result = reduceWerewolf(state, {
      kind: "submit",
      submission: submission(effect.seat, effect.phase, autoAction(effect.seat, effect.phase)),
    });
    state = result.state;
    queue.push(...result.effects);
    if (effect.phase === target) answered += 1;
  }
  return state;
}

const callSeats = (effects: WerewolfEffect[]) =>
  effects.flatMap((effect) => (effect.kind === "call_seat" ? [effect.seat] : []));

const recalled = (effects: WerewolfEffect[]) =>
  effects.flatMap((effect) =>
    effect.kind === "emit" && effect.event.type === "seat.recalled"
      ? [Number(effect.event.seat)]
      : [],
  );

describe("werewolf recovery", () => {
  test("a parallel phase re-calls exactly the seats that never answered", () => {
    const state = playTo("day_vote", 3);
    expect(state.phase).toBe("day_vote");
    expect(state.callMode).toBe("parallel");
    const answered = Object.keys(state.pending).map(Number);
    expect(answered).toHaveLength(3);

    const { effects } = recoverWerewolf(state);
    const seats = callSeats(effects);
    // The dead are not on the ballot, so the queue is shorter than nine.
    expect(seats).toHaveLength(state.queue.length - answered.length);
    for (const seat of answered) expect(seats).not.toContain(seat);
    expect(recalled(effects)).toEqual(seats);
  });

  test("a sequential phase whose call was in flight re-calls that one seat", () => {
    const state = playTo("night_wolves", 1);
    expect(state.phase).toBe("night_wolves");
    expect(state.queueIndex).toBe(2);
    expect(Object.keys(state.pending).map(Number)).toEqual([0]);

    const { state: next, effects } = recoverWerewolf(state);
    expect(callSeats(effects)).toEqual([1]);
    // The index must not move: the machine already counts this call as issued.
    expect(next.queueIndex).toBe(2);
  });

  test("a crash between the last submit and the next call picks the next seat up", () => {
    const state = playTo("night_wolves", 2);
    expect(state.queueIndex).toBe(3);
    expect(Object.keys(state.pending).map(Number).sort()).toEqual([0, 1]);

    const { state: next, effects } = recoverWerewolf(state);
    expect(callSeats(effects)).toEqual([2]);
    expect(next.queueIndex).toBe(3);
  });

  test("a crash inside the deciding round re-calls only the missing wolf", () => {
    // Three discussion answers, then one deciding answer: the next wolf never replied.
    const state = playTo("night_wolves", 4);
    expect(state.phase).toBe("night_wolves");
    expect(state.night.wolfStage).toBe("decide");
    expect(Object.keys(state.pending).map(Number)).toEqual([0]);

    const { effects } = recoverWerewolf(state);
    expect(callSeats(effects)).toEqual([1]);
  });

  test("a finished match has nothing to recover", () => {
    const state = { ...newState(), phase: "done" as WerewolfPhase };
    const { effects } = recoverWerewolf(state);
    expect(effects).toHaveLength(0);
  });

  test("a dawn phase walks the machine on instead of re-calling anyone", () => {
    // Night actions are all in and the kill is resolved; the process died before
    // `advance` could run `resolveDawn`.
    const base = playTo("night_seer", 0);
    const state: WerewolfState = {
      ...base,
      phase: "dawn",
      queue: [],
      queueIndex: 0,
      pending: {},
    };

    const { state: next, effects } = recoverWerewolf(state);
    expect(recalled(effects)).toHaveLength(0);
    // The machine moved on by itself: dawn resolved into the next phase.
    expect(next.phase).not.toBe("dawn");
  });
});

describe("checkpoints written before manual recall", () => {
  test("a state with no recalled list still resumes and still submits", () => {
    // A row written by the previous build has neither `recalled` nor
    // `lastForfeitPhase`; resuming must not throw on the missing fields.
    const live = reduceWerewolf(newState(), { kind: "start", at: 0 }).state;
    const legacy = live as unknown as Record<string, unknown>;
    delete legacy.recalled;
    const state = legacy as unknown as WerewolfState;
    for (const seat of state.seats) delete (seat as unknown as Record<string, unknown>).lastForfeitPhase;

    const resumed = recoverWerewolf(state);
    expect(resumed.state.matchId).toBe("m-recover");
    expect(resumed.effects.some((e) => e.kind === "call_seat")).toBe(true);
  });
});
