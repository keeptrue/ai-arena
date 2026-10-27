import { describe, expect, test } from "bun:test";
import { applyWerewolfEvent } from "../src/components/WerewolfTable";
import {
  REVIEW_STREAM_TAIL,
  ballotTotal,
  emptyReview,
  reviewActiveStreams,
  reviewChampion,
  reviewLiveCounts,
  reviewProgress,
  reviewRaterState,
  reviewSeat,
  reviewStream,
  seatModel,
  seatModelTitle,
  tableFromRoster,
} from "../src/lib/werewolf-frame";
import type { ArenaEvent, ModelSnapshot } from "../src/engine/types";
import type { ReviewSeatResult, ReviewVerdict } from "../src/engine/werewolf/review";

function model(i: number): ModelSnapshot {
  return {
    providerId: "mock",
    providerName: "演练场",
    kind: "mock",
    baseUrl: "",
    modelId: `rehearsal-${i}`,
    display: `演练体 ${i}`,
    temperature: 0.9,
    supportsReasoning: false,
  };
}

function table() {
  return tableFromRoster(
    Array.from({ length: 9 }, (_, seat) => ({ id: `p${seat}`, seat, model: model(seat + 1) })),
  );
}

function event(seq: number, type: ArenaEvent["type"], payload: Record<string, unknown>): ArenaEvent {
  return { seq, type, ts: seq, payload };
}

const RATERS: Array<number | "judge"> = [0, 1, 2, 3, 4, 5, 6, 7, 8, "judge"];

function ballot(seat: number, read = 7) {
  return {
    scores: Array.from({ length: 9 }, (_, target) => ({
      seat: target,
      read,
      voice: 6,
      craft: 6,
      poise: 6,
    })),
    mvp: 0,
    bestSpeech: 1,
    bestDeception: 2,
    summary: `${seat + 1}号的总结`,
  };
}

function row(seat: number, total: number): ReviewSeatResult {
  return {
    seat,
    read: 7,
    voice: 6,
    craft: 6,
    poise: 6,
    total,
    judgeTotal: total,
    selfTotal: total,
    mvpVotes: seat === 0 ? 2 : 0,
    bestSpeechVotes: 0,
    bestDeceptionVotes: 0,
    rank: seat + 1,
    tied: false,
    ballots: 10,
    dropped: [],
  };
}

function verdict(attempt: number): ReviewVerdict {
  return {
    attempt,
    weights: { read: 0.35, voice: 0.3, craft: 0.25, poise: 0.1 },
    ranking: Array.from({ length: 9 }, (_, seat) => row(seat, 90 - seat)),
    mvp: 0,
    bestSpeech: 1,
    bestDeception: 2,
    provisional: false,
    judge: true,
    raters: { players: 9, judge: true, missing: [] },
    usage: { calls: 10, tokens: 1000 },
  };
}

describe("review event reducer", () => {
  test("review.opened starts an attempt and records the expected raters", () => {
    const state = applyWerewolfEvent(
      table(),
      event(1, "review.opened", {
        attempt: 1,
        expected: 10,
        raters: RATERS,
        rubric: {
          weights: { read: 0.35, voice: 0.3, craft: 0.25, poise: 0.1 },
          selfWeight: 0,
          judgeVotes: 2,
          trim: true,
          minBallots: 4,
        },
      }),
    );
    expect(state.review.attempt).toBe(1);
    expect(state.review.opened).toBe(true);
    expect(state.review.running).toBe(true);
    expect(state.review.expected).toBe(10);
    expect(state.review.raters).toEqual(RATERS);
    expect(state.review.rubric?.judgeVotes).toBe(2);
  });

  test("a repeated ballot overwrites the same rater instead of stacking", () => {
    let state = applyWerewolfEvent(table(), event(1, "review.opened", { attempt: 1, expected: 10 }));
    state = applyWerewolfEvent(
      state,
      event(2, "review.ballot", { attempt: 1, rater: 3, status: "ok", ballot: ballot(3, 6) }),
    );
    state = applyWerewolfEvent(
      state,
      event(3, "review.ballot", { attempt: 1, rater: 3, status: "ok", ballot: ballot(3, 9) }),
    );
    const ballots = state.review.ballots.filter((b) => b.rater === 3);
    expect(ballots).toHaveLength(1);
    expect(ballots[0].ballot?.scores[0].read).toBe(9);
  });

  test("a forfeit is terminal and keeps its reason", () => {
    const state = applyWerewolfEvent(
      applyWerewolfEvent(table(), event(1, "review.opened", { attempt: 1, expected: 10 })),
      event(2, "review.ballot", { attempt: 1, rater: "judge", status: "forfeit", error: "timeout" }),
    );
    const judge = state.review.ballots.find((b) => b.rater === "judge");
    expect(judge?.status).toBe("forfeit");
    expect(judge?.error).toBe("timeout");
    expect(judge?.ballot).toBeNull();
  });

  test("a verdict closes the attempt and the progress sees every ballot", () => {
    let state = applyWerewolfEvent(
      table(),
      event(1, "review.opened", { attempt: 1, expected: 10, raters: RATERS }),
    );
    for (const rater of RATERS) {
      state = applyWerewolfEvent(
        state,
        event(10 + (typeof rater === "number" ? rater : 99), "review.ballot", {
          attempt: 1,
          rater,
          status: "ok",
          ballot: ballot(typeof rater === "number" ? rater : 8),
        }),
      );
    }
    state = applyWerewolfEvent(state, event(200, "review.verdict", verdict(1) as unknown as Record<string, unknown>));
    expect(state.review.running).toBe(false);
    expect(state.review.verdict?.ranking[0].total).toBe(90);
    const progress = reviewProgress(state.review, { judge: true });
    expect(progress.done).toBe(10);
    expect(progress.failed).toBe(0);
    expect(progress.pending).toEqual([]);
    expect(progress.ratio).toBe(1);
  });

  test("a force re-score clears the old ballots and ignores the old verdict", () => {
    let state = applyWerewolfEvent(table(), event(1, "review.opened", { attempt: 1, expected: 10, raters: RATERS }));
    state = applyWerewolfEvent(
      state,
      event(2, "review.ballot", { attempt: 1, rater: 0, status: "ok", ballot: ballot(0) }),
    );
    state = applyWerewolfEvent(state, event(3, "review.verdict", verdict(1) as unknown as Record<string, unknown>));
    state = applyWerewolfEvent(state, event(4, "review.opened", { attempt: 2, expected: 10, raters: RATERS }));
    expect(state.review.attempt).toBe(2);
    expect(state.review.ballots).toEqual([]);
    expect(state.review.verdict).toBeNull();
    expect(state.review.running).toBe(true);
  });

  test("stale events from an older attempt are ignored", () => {
    let state = applyWerewolfEvent(table(), event(1, "review.opened", { attempt: 2, expected: 10, raters: RATERS }));
    state = applyWerewolfEvent(
      state,
      event(2, "review.ballot", { attempt: 1, rater: 0, status: "ok", ballot: ballot(0) }),
    );
    state = applyWerewolfEvent(state, event(3, "review.verdict", verdict(1) as unknown as Record<string, unknown>));
    expect(state.review.attempt).toBe(2);
    expect(state.review.ballots).toEqual([]);
    expect(state.review.verdict).toBeNull();
  });

  test("re-opening the same attempt keeps its ballots and refreshes the rubric", () => {
    let state = applyWerewolfEvent(table(), event(1, "review.opened", { attempt: 1, expected: 10, raters: RATERS }));
    state = applyWerewolfEvent(
      state,
      event(2, "review.ballot", { attempt: 1, rater: 0, status: "ok", ballot: ballot(0) }),
    );
    state = applyWerewolfEvent(
      state,
      event(3, "review.opened", {
        attempt: 1,
        expected: 10,
        raters: RATERS,
        rubric: { weights: { read: 0.4, voice: 0.3, craft: 0.2, poise: 0.1 }, judgeVotes: 2 },
      }),
    );
    expect(state.review.ballots).toHaveLength(1);
    expect(state.review.rubric?.weights.read).toBe(0.4);
  });

  test("a review anomaly goes to the operator log", () => {
    const state = applyWerewolfEvent(
      table(),
      event(1, "anomaly", { code: "review_judge_seated", message: "裁判与座位同模型" }),
    );
    const entry = state.godLog.find((item) => item.kind === "review");
    expect(entry?.text).toContain("review_judge_seated");
    expect(state.publicLog.some((item) => item.text.includes("review_judge_seated"))).toBe(false);
  });
});

describe("review view helpers", () => {
  test("emptyReview is a clean slate", () => {
    const review = emptyReview();
    expect(review.attempt).toBe(0);
    expect(review.ballots).toEqual([]);
    expect(review.verdict).toBeNull();
  });

  test("ballotTotal is the weighted 1–10 score", () => {
    const total = ballotTotal(
      { seat: 0, read: 10, voice: 10, craft: 10, poise: 10 },
      { read: 0.35, voice: 0.3, craft: 0.25, poise: 0.1 },
    );
    expect(total).toBe(10);
    expect(
      ballotTotal(
        { seat: 0, read: 1, voice: 1, craft: 1, poise: 1 },
        { read: 0.35, voice: 0.3, craft: 0.25, poise: 0.1 },
      ),
    ).toBe(1);
    expect(ballotTotal(null, null)).toBeNull();
  });

  test("reviewChampion returns rank one and reviewSeat maps the display", () => {
    const state = table();
    expect(reviewSeat(state, 3)?.display).toBe("演练体 4");
    expect(reviewChampion(verdict(1))?.seat).toBe(0);
    expect(reviewChampion(null)).toBeNull();
  });

  test("seatModel names the model, and the provider only when two seats collide", () => {
    const state = tableFromRoster([
      {
        id: "p0",
        seat: 0,
        model: {
          ...model(1),
          providerName: "wb2api",
          modelId: "minimax-m3.1-flash",
          display: "MiniMax-M3.1-Flash",
        },
      },
      { id: "p1", seat: 1, model: model(2) },
      {
        id: "p2",
        seat: 2,
        model: {
          ...model(3),
          providerName: "qoder",
          modelId: "minimax-m3.1-flash",
          display: "MiniMax-M3.1-Flash",
        },
      },
    ]);
    // A unique name needs no provider; a shared one does, or two seats read alike.
    expect(seatModel(state.seats, 1)).toBe("演练体 2");
    expect(seatModel(state.seats, 0)).toBe("wb2api · MiniMax-M3.1-Flash");
    expect(seatModel(state.seats, 2)).toBe("qoder · MiniMax-M3.1-Flash");
    // No roster row (seat 8 was never dealt) names nothing — never "9号".
    expect(seatModel(state.seats, 8)).toBe("");
    expect(seatModelTitle(state.seats, 0)).toBe("wb2api · minimax-m3.1-flash");
    expect(seatModelTitle(state.seats, 8)).toBeUndefined();
  });

  test("progress treats a forfeit as failed, not pending", () => {
    const review = {
      ...emptyReview(),
      attempt: 1,
      opened: true,
      running: true,
      expected: 10,
      raters: RATERS,
      ballots: [
        { rater: 0 as const, status: "ok", ballot: ballot(0), error: "" },
        { rater: 1 as const, status: "forfeit", ballot: null, error: "timeout" },
      ],
    };
    const progress = reviewProgress(review, { judge: true });
    expect(progress.done).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.pending).toContain(2);
    expect(progress.pending).not.toContain(1);
  });
});

describe("review thinking stream", () => {
  const open = (attempt: number, ts = 100) =>
    event(ts, "review.opened", { attempt, expected: 10, raters: RATERS });
  const started = (rater: number | "judge", attempt = 1, ts = 101) =>
    event(ts, "review.rater.started", { attempt, rater });
  const chunk = (
    rater: number | "judge",
    delta: string,
    attempt = 1,
    ts = 102,
    channel: "note" | "reason" = "reason",
  ) => event(ts, "review.thinking.delta", { attempt, rater, channel, delta });

  function booted() {
    return applyWerewolfEvent(table(), open(1));
  }

  test("a started call reads as thinking; nothing was written yet", () => {
    const before = booted();
    expect(reviewRaterState(before.review, 0)).toBe("queued");
    const after = applyWerewolfEvent(before, started(0));
    expect(reviewRaterState(after.review, 0)).toBe("thinking");
    expect(reviewStream(after.review, 0)?.startedAt).toBe(101);
    // Announced but empty: no card, and no characters to show.
    expect(reviewActiveStreams(after.review)).toHaveLength(0);
    expect(reviewLiveCounts(after.review, { judge: true })).toMatchObject({
      thinking: 1,
      queued: 9,
      done: 0,
    });
  });

  test("characters are counted in full, the tail is all that is stored", () => {
    let state = applyWerewolfEvent(booted(), started(0));
    state = applyWerewolfEvent(state, chunk(0, "思".repeat(2_000)));
    const stream = reviewStream(state.review, 0);
    expect(stream?.reasonChars).toBe(2_000);
    expect(stream?.reason).toHaveLength(REVIEW_STREAM_TAIL);
    expect(stream?.noteChars).toBe(0);

    state = applyWerewolfEvent(state, chunk(0, "尾", 1, 103));
    const grown = reviewStream(state.review, 0);
    expect(grown?.reasonChars).toBe(2_001);
    expect(grown?.reason.endsWith("尾")).toBe(true);
    // Sliding never grows past the cap.
    expect(grown?.reason.length).toBe(REVIEW_STREAM_TAIL);
  });

  test("the two channels are counted apart and a ballot closes the rater", () => {
    let state = applyWerewolfEvent(booted(), started(0));
    state = applyWerewolfEvent(state, chunk(0, "看牌桌", 1, 102, "reason"));
    state = applyWerewolfEvent(state, chunk(0, '{"scores":', 1, 103, "note"));
    const stream = reviewStream(state.review, 0);
    expect(stream).toMatchObject({ reasonChars: 3, noteChars: 10 });
    expect(reviewActiveStreams(state.review)).toHaveLength(1);

    state = applyWerewolfEvent(
      state,
      event(104, "review.ballot", { attempt: 1, rater: 0, status: "ok", ballot: ballot(0) }),
    );
    expect(reviewRaterState(state.review, 0)).toBe("done");
    // The deliberation stays available as history, it just stops being "live".
    expect(reviewStream(state.review, 0)?.reason).toBe("看牌桌");
    expect(reviewLiveCounts(state.review, { judge: true })).toMatchObject({
      done: 1,
      thinking: 0,
    });
  });

  test("an old attempt's chunk never lands in the new attempt", () => {
    let state = applyWerewolfEvent(booted(), started(0));
    state = applyWerewolfEvent(state, chunk(0, "旧的一轮"));
    state = applyWerewolfEvent(state, open(2, 200));
    expect(state.review.streams).toEqual({});
    const stale = applyWerewolfEvent(state, chunk(0, "迟到的旧片段", 1, 201));
    expect(stale.review.streams).toEqual({});
    const fresh = applyWerewolfEvent(state, chunk(0, "新一轮", 2, 202));
    expect(reviewStream(fresh.review, 0)?.reason).toBe("新一轮");
  });

  test("a chunk without a start still shows up (resumed mid-stream page)", () => {
    const state = applyWerewolfEvent(booted(), chunk("judge", "补上的片段", 1, 300));
    const stream = reviewStream(state.review, "judge");
    // No start event survived the reload: the chunk itself proves the call ran.
    expect(stream?.startedAt).toBe(300);
    expect(reviewRaterState(state.review, "judge")).toBe("thinking");
  });

  test("a stale attempt in a late voter never rewrites the open round", () => {
    const state = applyWerewolfEvent(booted(), chunk(0, "进行中"));
    const late = applyWerewolfEvent(
      state,
      event(400, "review.ballot", { attempt: 0, rater: 1, status: "ok", ballot: ballot(1) }),
    );
    expect(late.review.ballots).toHaveLength(0);
    expect(reviewStream(late.review, 0)?.reason).toBe("进行中");
  });
});
