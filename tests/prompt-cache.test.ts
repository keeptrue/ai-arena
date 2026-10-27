/**
 * Prefix-cache invariants.
 *
 * Caching only pays when two calls share a *byte-identical* prefix, so these tests
 * pin the layout instead of the wording: rules before identity, history before the
 * present, the breakpoint at the end of the reusable block. If a future edit moves
 * a timestamp, a counter or a per-seat line to the front of a prompt, these fail.
 */
import { describe, expect, test } from "bun:test";
import { parseBlueprint } from "../src/engine/blueprint";
import { createCacheGate } from "../src/engine/cache-gate";
import { buildParticipantPrompt } from "../src/engine/prompt";
import { createMatchState } from "../src/engine/round";
import { parseWerewolfBlueprint } from "../src/engine/werewolf/blueprint";
import { buildSeatPrompt } from "../src/engine/werewolf/prompt";
import { createWerewolfState } from "../src/engine/werewolf/reduce";
import type { MatchState, RoundRecord } from "../src/engine/types";

/* ── werewolf ──────────────────────────────────────────────────────── */

const WW = {
  mode: "werewolf",
  id: "ww-cache",
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

const ROLES = ["wolf", "wolf", "wolf", "villager", "villager", "villager", "seer", "witch", "hunter"] as const;

function wolfTable(day = 2, phase: "day_speech" | "day_vote" | "night_wolves" = "day_speech") {
  const spec = parseWerewolfBlueprint(WW);
  const state = createWerewolfState({
    matchId: "m-cache",
    spec,
    seed: "seed",
    dealSource: "manual",
    seats: ROLES.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
    budget: { maxCalls: 200, maxTokens: 0 },
    at: 0,
  });
  state.day = day;
  state.phase = phase;
  state.publicLog.push({ kind: "dawn", day: 1, deaths: [] });
  state.publicLog.push({ kind: "speech", day: 1, seat: 0, text: "我保 2 号，狼坑在 4、5。" });
  state.publicLog.push({ kind: "dawn", day: 2, deaths: [4] });
  state.publicLog.push({ kind: "speech", day: 2, seat: 1, text: "我站 1 号。" });
  return state;
}

const headOf = (prompt: { messages: Array<{ content: string; cacheAt?: number }> }) => {
  const message = prompt.messages[0]!;
  return message.content.slice(0, message.cacheAt ?? message.content.length);
};

describe("werewolf prompt prefix", () => {
  test("all nine seats share one byte-identical system", () => {
    const state = wolfTable();
    const systems = ROLES.map((_, seat) => buildSeatPrompt({ state, seat }).system);
    expect(systems[0]!.length).toBeGreaterThan(200);
    for (const system of systems) expect(system).toBe(systems[0]!);
  });

  test("speaking and voting share the same system — only the tail differs", () => {
    const speech = buildSeatPrompt({ state: wolfTable(2, "day_speech"), seat: 3 });
    const vote = buildSeatPrompt({ state: wolfTable(2, "day_vote"), seat: 3 });
    expect(speech.system).toBe(vote.system);
    expect(headOf(speech)).toBe(headOf(vote));
  });

  test("the cacheable head is the chronicle, and it is the same for every seat", () => {
    const state = wolfTable();
    const prompts = ROLES.map((_, seat) => buildSeatPrompt({ state, seat }));
    const heads = prompts.map(headOf);
    for (const head of heads) expect(head).toBe(heads[0]!);
    // The head stops before the table state; the seat's own task is not in it.
    expect(heads[0]).toContain("## 公开编年史");
    expect(heads[0]).not.toContain("## 牌桌");
    expect(heads[0]).not.toContain("## 本轮可选目标");
  });

  test("a new speech only appends to the head; it never rewrites it", () => {
    const state = wolfTable();
    const before = headOf(buildSeatPrompt({ state, seat: 3 }));
    state.publicLog.push({ kind: "speech", day: 2, seat: 3, text: "后面还有四个人没说话，我不表态。" });
    const after = headOf(buildSeatPrompt({ state, seat: 3 }));
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  test("yesterday's block is frozen: a new day only appends to it", () => {
    const state = wolfTable();
    // Trim the blank line that joins the block to the next heading: only content counts.
    const historyOf = (content: string) => content.slice(0, content.indexOf("### 今天")).trimEnd();

    const day2 = historyOf(buildSeatPrompt({ state, seat: 3 }).messages[0]!.content);

    state.day = 3;
    state.publicLog.push({ kind: "dawn", day: 3, deaths: [2] });
    const day3 = historyOf(buildSeatPrompt({ state, seat: 3 }).messages[0]!.content);

    // Day 1 keeps the exact bytes it had when it was still "today"'s neighbour.
    expect(day3.startsWith(day2)).toBe(true);
    expect(day3.length).toBeGreaterThan(day2.length);
  });

  test("the phase still sits in the tail, not in the shared head", () => {
    const speech = buildSeatPrompt({ state: wolfTable(2, "day_speech"), seat: 3 });
    const vote = buildSeatPrompt({ state: wolfTable(2, "day_vote"), seat: 3 });
    expect(headOf(speech)).toBe(headOf(vote));
    expect(speech.messages[0]!.content).not.toBe(vote.messages[0]!.content);
  });
});

/* ── rubric participants ───────────────────────────────────────────── */

const RUBRIC = {
  id: "cache-rubric",
  name: "对局",
  tagline: "",
  rounds: 3,
  briefing: "这是一段足够长的规则正文，用来满足最小字数限制，也让选手有东西可读。每轮同时提交一个选择。",
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

const model = {
  providerId: "p",
  providerName: "P",
  kind: "mock" as const,
  baseUrl: "",
  modelId: "m",
  display: "m",
  temperature: 1,
  supportsReasoning: false,
};

function rubricState(): MatchState {
  const blueprint = parseBlueprint(RUBRIC);
  return createMatchState({
    matchId: "m-rc",
    rulesetId: "r1",
    blueprint,
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
    at: 0,
  });
}

const record = (round: number): RoundRecord => ({
  round,
  sudden: false,
  closedAt: round * 1000,
  submissions: [
    { participantId: "p1", seat: 1, teamId: "t1", status: "ready", thinking: "", content: { move: "合作" } },
    { participantId: "p2", seat: 2, teamId: "t2", status: "ready", thinking: "", content: { move: "出卖" } },
  ],
  verdict: null,
  teamScores: { t1: 5, t2: 5 },
});

describe("rubric participant prefix", () => {
  test("next round's history block starts with this round's", () => {
    const state = rubricState();
    const prompt = () =>
      buildParticipantPrompt({ blueprint: state.blueprint, state, participant: state.participants[0]!, interventions: [] });

    state.round = 2;
    state.history = [record(1)];
    const head2 = headOf(prompt());

    state.round = 3;
    state.history = [record(1), record(2)];
    const head3 = headOf(prompt());

    expect(head2).toContain("第 1 轮");
    expect(head3.startsWith(head2)).toBe(true);
  });

  test("the round number and the score live after the breakpoint", () => {
    const state = rubricState();
    state.round = 2;
    state.history = [record(1)];
    const prompt = buildParticipantPrompt({
      blueprint: state.blueprint,
      state,
      participant: state.participants[0]!,
      interventions: [],
    });
    const head = headOf(prompt);
    const tail = prompt.messages[0]!.content.slice(head.length);
    expect(head).not.toContain("现在是第 2 / 3 轮");
    expect(tail).toContain("现在是第 2 / 3 轮");
    expect(tail).toContain("## 本轮你要提交");
  });
});

/* ── the fan-out gate ──────────────────────────────────────────────── */

describe("cache gate", () => {
  test("the first caller runs free, the rest wait for its release", async () => {
    const gate = createCacheGate({ holdMs: 5_000 });
    const first = await gate.acquire("k");
    let secondDone = false;
    const second = gate.acquire("k").then(() => {
      secondDone = true;
      return null;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false);
    first();
    await second;
    expect(secondDone).toBe(true);
  });

  test("a warmer that dies never strands the table", async () => {
    const gate = createCacheGate({ holdMs: 30 });
    await gate.acquire("k");
    const started = Date.now();
    await gate.acquire("k");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("different keys do not wait on each other", async () => {
    const gate = createCacheGate({ holdMs: 5_000 });
    await gate.acquire("phase-1");
    await gate.acquire("phase-2");
  });

  test("holdMs 0 disables the gate entirely", async () => {
    const gate = createCacheGate({ holdMs: 0 });
    await gate.acquire("k");
    await gate.acquire("k");
  });
});
