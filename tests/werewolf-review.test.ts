import { describe, expect, test } from "bun:test";
import { parseWerewolfBlueprint } from "../src/engine/werewolf/blueprint";
import {
  aggregateReview,
  buildReviewPacket,
  buildReviewPrompt,
  parseReviewBallot,
  planReviewRaters,
  resolveReviewRules,
  reviewAttempt,
  weightedTotal,
  type ReviewBallot,
  type ReviewRules,
} from "../src/engine/werewolf/review";
import { createWerewolfState, reduceWerewolf } from "../src/engine/werewolf/reduce";
import type {
  PhaseAction,
  WerewolfAction,
  WerewolfBlueprint,
  WerewolfEffect,
  WerewolfRoleId,
  WerewolfState,
} from "../src/engine/werewolf/types";
import type { ArenaEvent } from "../src/engine/types";

const SPEC: WerewolfBlueprint = parseWerewolfBlueprint({
  mode: "werewolf",
  id: "ww-review-test",
  name: "预女猎九人局",
  tagline: "复盘测试",
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

function makeState(roles: WerewolfRoleId[] = ROLES): WerewolfState {
  return createWerewolfState({
    matchId: "m-review",
    spec: SPEC,
    seed: "seed-review",
    dealSource: "manual",
    seats: roles.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
    budget: { maxCalls: 999, maxTokens: 0 },
    at: 0,
  });
}

type Script = Record<string, PhaseAction | ((state: WerewolfState) => PhaseAction | null)>;

const text = (s: string) => ({ kind: "speech" as const, text: s });
const vote = (target: number | "abstain") => ({ kind: "vote" as const, target });
const none = { kind: "witch" as const, action: "none" as const, target: null };

/** Play until the first vote tally, which is enough material for a review packet. */
function playDayOne(script: Script): { state: WerewolfState; events: ArenaEvent[] } {
  let state = makeState();
  const events: ArenaEvent[] = [];
  const effects: WerewolfEffect[] = [];
  let seq = 1;

  const apply = (action: WerewolfAction) => {
    const result = reduceWerewolf(state, action);
    state = result.state;
    effects.push(...result.effects);
  };

  apply({ kind: "start", at: 0 });
  let guard = 0;
  while (guard++ < 400) {
    const effect = effects.shift();
    if (!effect) break;
    if (effect.kind === "emit") {
      events.push({ ...effect.event, seq: seq++ });
      continue;
    }
    if (effect.kind === "finish") continue;
    const value = script[`${effect.phase}:${effect.seat}`];
    const action = typeof value === "function" ? value(state) : value;
    apply({
      kind: "submit",
      submission: {
        seat: effect.seat,
        phase: effect.phase,
        status: action ? "ready" : "forfeit",
        action: action ?? null,
        thinking: "私有旁白，绝不能进评分材料",
        reasoning: "私有推理，绝不能进评分材料",
        raw: "",
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
        anomalies: [],
      },
    });
    if (events.some((event) => event.type === "vote.tally")) break;
  }
  return { state, events };
}

const DAY_ONE: Script = {
  "night_wolves:0": { kind: "wolf", target: 3, talk: "先刀这个村民" },
  "night_wolves:1": { kind: "wolf", target: 3, talk: "跟" },
  "night_wolves:2": { kind: "wolf", target: 3, talk: "跟" },
  "night_seer:6": { kind: "seer", target: 0 },
  "night_witch:7": none,
  "day_speech:0": text("我先说，4号像好人"),
  "day_speech:1": text("我听预言家"),
  "day_speech:2": text("我过"),
  "day_speech:4": text("我过"),
  "day_speech:5": text("我过"),
  "day_speech:6": text("我是预言家，1号是狼"),
  "day_speech:7": text("我过"),
  "day_speech:8": text("我过"),
  "day_vote:0": vote(1),
  "day_vote:1": vote(0),
  "day_vote:2": vote(0),
  "day_vote:4": vote(0),
  "day_vote:5": vote(0),
  "day_vote:6": vote(0),
  "day_vote:7": vote(0),
  "day_vote:8": vote(0),
  "day_last_words:3": { kind: "last_words", text: "好人自己盘" },
};

type Dims = [number, number, number, number];

function ballot(
  rater: number | "judge",
  score: number | ((seat: number) => number | Dims),
  picks: Partial<Pick<ReviewBallot, "mvp" | "bestSpeech" | "bestDeception">> = {},
): ReviewBallot {
  const scores = Array.from({ length: 9 }, (_, seat) => {
    const value = typeof score === "function" ? score(seat) : score;
    const [read, voice, craft, poise] = typeof value === "number" ? [value, value, value, value] : value;
    return { seat, read, voice, craft, poise };
  });
  return {
    rater,
    scores,
    mvp: picks.mvp ?? null,
    bestSpeech: picks.bestSpeech ?? null,
    bestDeception: picks.bestDeception ?? null,
    summary: "",
  };
}

function event(seq: number, type: ArenaEvent["type"], payload: Record<string, unknown>): ArenaEvent {
  return { seq, type, ts: seq, payload };
}

describe("review rules", () => {
  test("defaults match the agreed rubric", () => {
    const rules = resolveReviewRules(SPEC);
    expect(rules.enabled).toBe(true);
    expect(rules.selfWeight).toBe(0);
    expect(rules.judgeVotes).toBe(2);
    expect(rules.trim).toBe(true);
    expect(rules.minBallots).toBe(4);
    expect(rules.weights.read).toBeCloseTo(0.35);
    expect(rules.weights.voice).toBeCloseTo(0.3);
    expect(rules.weights.craft).toBeCloseTo(0.25);
    expect(rules.weights.poise).toBeCloseTo(0.1);
  });

  test("blueprint overrides are normalized and clamped", () => {
    const spec: WerewolfBlueprint = {
      ...SPEC,
      review: { selfWeight: 5, judgeVotes: 9, minBallots: 0, weights: { read: 2, voice: 1, craft: 1, poise: 0 } },
    };
    const rules = resolveReviewRules(spec);
    expect(rules.selfWeight).toBe(1);
    expect(rules.judgeVotes).toBe(3);
    expect(rules.minBallots).toBe(1);
    expect(rules.weights.read).toBeCloseTo(0.5);
    expect(rules.weights.voice).toBeCloseTo(0.25);
    expect(rules.weights.craft).toBeCloseTo(0.25);
    expect(rules.weights.poise).toBeCloseTo(0);
  });
});

describe("rater plan", () => {
  const seats = new Map([
    [0, { providerId: "vendor-a", modelId: "alpha" }],
    [1, { providerId: "vendor-b", modelId: "beta" }],
  ]);

  test("a judge that also sits at the table still gets the tenth ballot", () => {
    const plan = planReviewRaters(seats, { providerId: "vendor-b", modelId: "beta" });
    expect(plan.raters).toEqual([0, 1, "judge"]);
    expect(plan.judgeSeat).toBe(1);
  });

  test("a judge off the table votes without a judgeSeat", () => {
    const plan = planReviewRaters(seats, { providerId: "vendor-z", modelId: "omega" });
    expect(plan.raters).toEqual([0, 1, "judge"]);
    expect(plan.judgeSeat).toBeNull();
  });

  test("no frozen judge means seats only", () => {
    expect(planReviewRaters(seats, null)).toEqual({ raters: [0, 1], judgeSeat: null });
  });
});

describe("review packet", () => {
  test("facts carry roles, night actions, votes and deaths", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events);

    expect(packet.seats).toHaveLength(9);
    expect(packet.facts.nights).toHaveLength(1);
    expect(packet.facts.nights[0]).toMatchObject({
      day: 1,
      kill: 3,
      saved: false,
      poison: null,
      seer: { day: 1, seat: 6, target: 0, result: "wolf" },
    });
    expect(packet.facts.votes[0].exiled).toBe(0);
    expect(packet.facts.votes[0].votes[0]).toBe(1);
    expect(packet.facts.seats[3].death).toEqual({ day: 1, cause: "wolf" });
    expect(packet.facts.seats[0].death).toEqual({ day: 1, cause: "vote" });
    expect(packet.facts.seats[6].role).toBe("seer");
    expect(packet.factsText).toContain("身份与结局");
    expect(packet.factsText).toContain("夜间账本");
    expect(packet.factsText).toContain("票型账本");
    expect(packet.factsText).toContain("第1夜验1号=狼");
  });

  test("chronicle keeps the public story and never leaks private notes", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events);

    expect(packet.chronicle).toContain("第1天");
    expect(packet.chronicle).toContain("预言家7号验1号");
    expect(packet.chronicle).toContain("1号被放逐");
    expect(packet.chronicle).toContain("发言");
    expect(packet.chronicle).not.toContain("私有旁白");
    expect(packet.factsText).not.toContain("私有推理");
  });

  test("chronicle is capped from the earliest day", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events, 600);
    expect(packet.chronicle.length).toBeLessThanOrEqual(600);
    expect(packet.chronicle).toContain("赛后翻牌");
  });
});

describe("review prompt", () => {
  /** The rater's own instructions live in the user tail; the shared packet is the head. */
  const fullText = (prompt: { system: string; messages: Array<{ content: string }> }) =>
    [prompt.system, ...prompt.messages.map((m) => m.content)].join("\n");

  test("player prompt names the seat and asks for a self score", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events);
    const prompt = buildReviewPrompt({
      packet,
      rater: { kind: "seat", seat: 2 },
      rules: resolveReviewRules(SPEC),
    });
    const text = fullText(prompt);
    expect(text).toContain("你是 3 号玩家");
    expect(text).toContain("包括你自己");
    expect(text).toContain("自评会单列展示");
    expect(prompt.messages[0]?.content).toContain("赛后事实卡");
    expect(prompt.messages[0]?.content).toContain("公开编年史");
    expect(text).not.toContain("演练体");
    expect(text).not.toContain("provider");
    expect(text).not.toContain("<<<THINK>>>");
    expect(text).not.toContain("thinking");
  });

  test("judge prompt sees seats only, never model identity", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events);
    const prompt = buildReviewPrompt({
      packet,
      rater: { kind: "judge" },
      rules: resolveReviewRules(SPEC),
    });
    const text = fullText(prompt);
    expect(text).toContain("你是本局裁判");
    expect(text).toContain("没有模型名");
    expect(text).not.toContain("3 号玩家");
    expect(text).not.toContain("演练体");
    expect(text).not.toContain("deepseek");
    expect(text).not.toContain("openai");
    expect(text).not.toContain("<<<THINK>>>");
  });

  test("a judge that also sat down is told which seat it is grading", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events);
    const prompt = buildReviewPrompt({
      packet,
      rater: { kind: "judge" },
      rules: resolveReviewRules(SPEC),
      judgeSeat: 2,
    });
    const text = fullText(prompt);
    expect(text).toContain("你是本局裁判");
    expect(text).toContain("同时也坐在 3 号位");
    expect(text).toContain("包括你自己那一席");
    expect(text).not.toContain("你没有自评");
    expect(text).not.toContain("3 号玩家");
  });

  test("all ten ballots share one byte-identical system and the same packet head", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events);
    const rules = resolveReviewRules(SPEC);

    const raters = [
      ...Array.from({ length: 9 }, (_, seat) => ({ kind: "seat" as const, seat })),
      { kind: "judge" as const },
    ].map((rater) => buildReviewPrompt({ packet, rater, rules, judgeSeat: 2 }));

    const first = raters[0];
    const firstPacket = first.messages[0]?.content.slice(0, first.messages[0].cacheAt) ?? "";
    expect(firstPacket.length).toBeGreaterThan(200);
    for (const prompt of raters) {
      expect(prompt.system).toBe(first.system);
      const head = prompt.messages[0]?.content.slice(0, prompt.messages[0].cacheAt) ?? "";
      expect(head).toBe(firstPacket);
    }
  });

  test("prompt stays inside a bounded context", () => {
    const { state, events } = playDayOne(DAY_ONE);
    const packet = buildReviewPacket(state, events);
    const prompt = buildReviewPrompt({
      packet,
      rater: { kind: "seat", seat: 0 },
      rules: resolveReviewRules(SPEC),
    });
    expect(prompt.system.length + (prompt.messages[0]?.content.length ?? 0)).toBeLessThan(40_000);
  });
});

describe("review ballot parsing", () => {
  const valid = {
    scores: Array.from({ length: 9 }, (_, seat) => ({
      seat: seat + 1,
      read: 7,
      voice: 7,
      craft: 7,
      poise: 7,
      comment: "稳",
    })),
    mvp: 4,
    bestSpeech: 2,
    bestDeception: 7,
    summary: "一句话",
  };

  test("parses a valid 9-row ballot and converts seats to 0-based", () => {
    const parsed = parseReviewBallot(JSON.stringify(valid));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ballot.scores).toHaveLength(9);
    expect(parsed.ballot.scores[0].seat).toBe(0);
    expect(parsed.ballot.scores[8].seat).toBe(8);
    expect(parsed.ballot.mvp).toBe(3);
  });

  test("repairs a fenced payload with prose around it", () => {
    const parsed = parseReviewBallot(`下面是评分：\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n谢谢。`);
    expect(parsed.ok).toBe(true);
  });

  test("rejects a missing row", () => {
    const parsed = parseReviewBallot(JSON.stringify({ ...valid, scores: valid.scores.slice(0, 8) }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("scores_length");
  });

  test("rejects a duplicate seat", () => {
    const scores = valid.scores.map((row) => ({ ...row }));
    scores[1].seat = 1;
    const parsed = parseReviewBallot(JSON.stringify({ ...valid, scores }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("seat_duplicate");
  });

  test("rejects 0-based seats", () => {
    const scores = valid.scores.map((row) => ({ ...row, seat: row.seat - 1 }));
    const parsed = parseReviewBallot(JSON.stringify({ ...valid, scores }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("seat_invalid");
  });

  test("rejects out-of-range and fractional scores", () => {
    const zero = valid.scores.map((row) => ({ ...row }));
    zero[0].read = 0;
    expect(parseReviewBallot(JSON.stringify({ ...valid, scores: zero })).ok).toBe(false);

    const fraction = valid.scores.map((row) => ({ ...row }));
    fraction[0].voice = 7.5;
    expect(parseReviewBallot(JSON.stringify({ ...valid, scores: fraction })).ok).toBe(false);
  });

  test("invalid special votes become null without failing the ballot", () => {
    const parsed = parseReviewBallot(JSON.stringify({ ...valid, mvp: 0, bestSpeech: 12, bestDeception: null }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ballot.mvp).toBeNull();
    expect(parsed.ballot.bestSpeech).toBeNull();
    expect(parsed.ballot.bestDeception).toBeNull();
  });

  test("clips long comments and summaries", () => {
    const scores = valid.scores.map((row) => ({ ...row, comment: "x".repeat(200) }));
    const parsed = parseReviewBallot(JSON.stringify({ ...valid, scores, summary: "y".repeat(400) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ballot.scores[0].comment?.length).toBe(80);
    expect(parsed.ballot.summary.length).toBe(200);
  });
});

describe("review aggregation", () => {
  const rules: ReviewRules = resolveReviewRules(SPEC);

  test("self score is displayed but excluded from the total", () => {
    const state = makeState();
    const generous = Array.from({ length: 9 }, (_, rater) =>
      ballot(rater, (seat) => (seat === rater ? 10 : 6)),
    );
    const modest = Array.from({ length: 9 }, (_, rater) =>
      ballot(rater, (seat) => (seat === rater ? 1 : 6)),
    );
    const a = aggregateReview({ state, ballots: generous, judge: null, rules });
    const b = aggregateReview({ state, ballots: modest, judge: null, rules });
    const seat0a = a.ranking.find((row) => row.seat === 0)!;
    const seat0b = b.ranking.find((row) => row.seat === 0)!;
    expect(seat0a.total).toBe(60);
    expect(seat0b.total).toBe(60);
    expect(seat0a.selfTotal).toBe(100);
    expect(seat0b.selfTotal).toBe(10);
  });

  test("a blueprint can give the self ballot a half weight", () => {
    const state = makeState();
    const players = Array.from({ length: 9 }, (_, rater) =>
      ballot(rater, (seat) => (seat === rater ? 10 : 6)),
    );
    const zero = aggregateReview({ state, ballots: players, judge: null, rules });
    const half = aggregateReview({
      state,
      ballots: players,
      judge: null,
      rules: { ...rules, selfWeight: 0.5 },
    });
    expect(zero.ranking.find((row) => row.seat === 0)?.total).toBe(60);
    expect(half.ranking.find((row) => row.seat === 0)?.total).toBeCloseTo(62.4);
  });

  test("trims one highest and one lowest peer ballot", () => {
    const state = makeState();
    const ballots = Array.from({ length: 8 }, (_, index) => {
      const rater = index + 1;
      return ballot(rater, rater === 1 ? 10 : rater === 2 ? 1 : 6);
    });
    const trimmed = aggregateReview({ state, ballots, judge: null, rules });
    const raw = aggregateReview({ state, ballots, judge: null, rules: { ...rules, trim: false } });
    const seat0 = trimmed.ranking.find((row) => row.seat === 0)!;
    const seat0raw = raw.ranking.find((row) => row.seat === 0)!;
    expect(seat0.total).toBe(60);
    expect(seat0raw.total).toBe(58.8);
    expect(seat0.dropped.sort()).toEqual([1, 2]);
  });

  test("the judge ballot is worth two votes", () => {
    const state = makeState();
    const players = Array.from({ length: 9 }, (_, rater) => ballot(rater, 6));
    const judge = ballot("judge", 10);
    const verdict = aggregateReview({ state, ballots: players, judge, rules });
    const seat0 = verdict.ranking.find((row) => row.seat === 0)!;
    expect(seat0.total).toBe(68);
    expect(seat0.judgeTotal).toBe(100);
    expect(seat0.ballots).toBe(10);
    expect(verdict.judge).toBe(true);
  });

  test("missing ballots shrink the denominator and are reported", () => {
    const state = makeState();
    const ballots = [0, 1, 2].map((rater) => ballot(rater, 6));
    const judge = ballot("judge", 8);
    const verdict = aggregateReview({
      state,
      ballots,
      judge,
      rules,
      missing: [3, 4, 5, "judge"],
    });
    expect(verdict.raters.players).toBe(3);
    expect(verdict.raters.missing).toContain(3);
    expect(verdict.provisional).toBe(true);
  });

  test("a losing-side wolf can still rank first", () => {
    const state = makeState();
    state.winner = "good";
    const ballots = Array.from({ length: 9 }, (_, rater) =>
      ballot(rater, (seat) => (seat === 0 ? 10 : 6)),
    );
    const verdict = aggregateReview({ state, ballots, judge: null, rules });
    expect(verdict.ranking[0].seat).toBe(0);
    expect(verdict.ranking[0].total).toBe(100);
  });

  test("MVP votes break a total tie", () => {
    const state = makeState();
    const ballots = Array.from({ length: 9 }, (_, rater) =>
      ballot(rater, 6, rater === 0 ? { mvp: 1 } : rater === 1 ? { mvp: 1 } : rater === 2 ? { mvp: 0 } : {}),
    );
    const verdict = aggregateReview({ state, ballots, judge: null, rules });
    expect(verdict.ranking[0].seat).toBe(1);
    expect(verdict.ranking[0].mvpVotes).toBe(2);
    expect(verdict.ranking[0].tied).toBe(true);
  });

  test("no ballots yields an empty, provisional verdict", () => {
    const state = makeState();
    const verdict = aggregateReview({ state, ballots: [], judge: null, rules });
    expect(verdict.ranking).toEqual([]);
    expect(verdict.provisional).toBe(true);
    expect(verdict.reason).toBe("no_ballots");
  });

  test("weighted total scales a 1–10 dimension row to 0–100", () => {
    expect(weightedTotal({ seat: 0, read: 10, voice: 10, craft: 10, poise: 10 }, rules.weights)).toBe(100);
    expect(weightedTotal({ seat: 0, read: 1, voice: 1, craft: 1, poise: 1 }, rules.weights)).toBe(10);
  });
});

describe("review attempt replay", () => {
  const body = {
    scores: Array.from({ length: 9 }, (_, seat) => ({
      seat,
      read: 7,
      voice: 7,
      craft: 7,
      poise: 7,
    })),
    mvp: 0,
    bestSpeech: 1,
    bestDeception: 2,
    summary: "",
  };

  test("uses the latest attempt and keeps forfeits terminal", () => {
    const events = [
      event(1, "review.opened", { attempt: 1, expected: 10 }),
      event(2, "review.ballot", { attempt: 1, rater: 0, status: "ok", ballot: body }),
      event(3, "review.ballot", { attempt: 1, rater: 1, status: "forfeit", error: "timeout" }),
      event(4, "review.verdict", { attempt: 1, ranking: [] }),
      event(5, "review.opened", { attempt: 2, expected: 10 }),
      event(6, "review.ballot", { attempt: 2, rater: "judge", status: "ok", ballot: body }),
    ];
    const attempt = reviewAttempt(events);
    expect(attempt.attempt).toBe(2);
    expect(attempt.opened).toBe(true);
    expect(attempt.verdict).toBeNull();
    expect(attempt.ballots).toHaveLength(1);
    expect(attempt.ballots[0].rater).toBe("judge");
    expect(attempt.terminal).toEqual(["judge"]);
  });

  test("the last ballot from the same rater wins", () => {
    const second = {
      ...body,
      scores: body.scores.map((row) => ({ ...row, read: 9 })),
    };
    const events = [
      event(1, "review.opened", { attempt: 1, expected: 10 }),
      event(2, "review.ballot", { attempt: 1, rater: 3, status: "ok", ballot: body }),
      event(3, "review.ballot", { attempt: 1, rater: 3, status: "ok", ballot: second }),
    ];
    const attempt = reviewAttempt(events);
    expect(attempt.ballots).toHaveLength(1);
    expect(attempt.ballots[0].scores[0].read).toBe(9);
  });

  test("no review events yields an empty attempt", () => {
    const attempt = reviewAttempt([]);
    expect(attempt.attempt).toBe(0);
    expect(attempt.opened).toBe(false);
    expect(attempt.ballots).toEqual([]);
  });
});
