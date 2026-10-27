import { describe, expect, test } from "bun:test";
import {
  applyWerewolfEvent,
  tableFromRoster,
} from "../src/components/WerewolfTable";
import {
  buildFrames,
  cleanThinking,
  decisionRounds,
  frameSpeech,
  frameSpeeches,
  frameThought,
  frameThoughts,
  seatActionFor,
  seatBallot,
  seatCardMid,
  seatStatus,
} from "../src/lib/werewolf-frame";
import type { ArenaEvent, ModelSnapshot } from "../src/engine/types";
import type { WerewolfRoleId } from "../src/engine/werewolf/types";

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

function event(seq: number, type: ArenaEvent["type"], payload: Record<string, unknown>): ArenaEvent {
  return { seq, type, ts: seq, payload };
}

/** A table parked at day 1, night finished, day speeches running. */
function nightThenDay() {
  const roster = Array.from({ length: 9 }, (_, seat) => ({ id: `p${seat}`, seat, model: model(seat) }));
  let state = tableFromRoster(roster);
  const events: ArenaEvent[] = [
    event(1, "match.created", {
      name: "预女猎九人局",
      tagline: "测试",
      maxDays: 8,
      briefing: "规则",
      seats: roster.map((p) => ({ participantId: p.id, seat: p.seat })),
    }),
    event(2, "roles.dealt", {
      source: "engine",
      seats: ROLES.map((role, seat) => ({ seat, role, camp: role === "wolf" ? "wolf" : "good" })),
    }),
    event(3, "phase.changed", { day: 1, phase: "night_wolves" }),
    event(4, "seat.submitted", {
      phase: "night_wolves",
      seat: 0,
      content: { kind: "wolf", target: 6, talk: "先刀 7 号外置位" },
      thinking: "想刀 7 号",
      reasoning: "native chain",
    }),
    event(5, "seat.submitted", {
      phase: "night_wolves",
      seat: 1,
      content: { kind: "wolf", target: 6, talk: "同意" },
      thinking: "跟刀",
    }),
    event(6, "phase.changed", { day: 1, phase: "night_seer" }),
    event(7, "seat.submitted", {
      phase: "night_seer",
      seat: 6,
      content: { kind: "seer", target: 1 },
      thinking: "验 2 号",
    }),
    event(8, "seer.check", { day: 1, seat: 6, target: 1, result: "good" }),
    event(9, "phase.changed", { day: 1, phase: "night_witch" }),
    event(10, "seat.submitted", {
      phase: "night_witch",
      seat: 7,
      content: { kind: "witch", action: "save", target: null },
      thinking: "救",
    }),
    event(11, "night.resolved", {
      day: 1,
      killTarget: 6,
      saved: true,
      poisonTarget: null,
      deaths: [],
    }),
    event(12, "phase.changed", { day: 1, phase: "dawn" }),
    event(13, "dawn", { day: 1, deaths: [] }),
    event(14, "phase.changed", { day: 1, phase: "day_speech" }),
    event(15, "seat.submitted", {
      phase: "day_speech",
      seat: 0,
      content: { kind: "speech", text: "1号发言。我是村民。" },
      thinking: "白天发言",
    }),
    event(16, "speech", { day: 1, seat: 0, text: "1号发言。我是村民。" }),
  ];
  for (const e of events) state = applyWerewolfEvent(state, e);
  return state;
}

/** The table parked at day 1's vote: one seat streaming, one already voted. */
function voteDay() {
  let view = nightThenDay();
  view = applyWerewolfEvent(view, event(30, "phase.changed", { day: 1, phase: "day_vote" }));
  view = applyWerewolfEvent(
    view,
    event(31, "seat.thinking.delta", {
      phase: "day_vote",
      seat: 0,
      delta: "这一票得压在 2 号身上，",
    }),
  );
  view = applyWerewolfEvent(
    view,
    event(32, "seat.submitted", {
      phase: "day_vote",
      seat: 1,
      content: { kind: "vote", target: 0 },
      thinking: "我投 1 号。",
      reasoning: "raw chain",
    }),
  );
  return view;
}

describe("werewolf frames", () => {
  test("a night frame carries every action, in submit order, in god view", () => {
    const view = nightThenDay();
    const frames = buildFrames(view, true);
    const night = frames.find((f) => f.id === "n1")!;
    const actions = night.items.filter((i) => i.kind === "action");
    expect(actions.map((a) => a.tag)).toEqual(["刀", "刀", "验", "药", "结算"]);
    expect(actions[0].text).toContain("刀 7号");
    expect(actions[0].text).toContain("先刀 7 号外置位");
    expect(actions[2].text).toContain("→ 好人");
    expect(night.items.at(-1)?.kind).toBe("dawn");
  });

  test("player view keeps the night frame free of secret actions", () => {
    const view = nightThenDay();
    const night = buildFrames(view, false).find((f) => f.id === "n1")!;
    expect(night.items.some((i) => i.kind === "action")).toBe(false);
    expect(night.items.map((i) => i.kind)).toEqual(["dawn"]);
  });

  test("a night frame never borrows the day's speech", () => {
    const view = nightThenDay();
    const frames = buildFrames(view, true);
    const night = frames.find((f) => f.id === "n1")!;
    const day = frames.find((f) => f.id === "d1")!;
    expect(frameSpeech(view, night, 0)).toBeNull();
    expect(frameSpeech(view, day, 0)?.kind).toBe("speech");
    expect(frameThought(view, night, 0)?.text).toBe("想刀 7 号");
    expect(frameThought(view, day, 0)?.text).toBe("白天发言");
  });

  test("a seat that spoke and then left last words keeps both lines", () => {
    let view = voteDay();
    view = applyWerewolfEvent(view, event(50, "last_words", { day: 1, seat: 0, text: "遗言" }));
    const day = buildFrames(view, true).find((f) => f.id === "d1")!;
    expect(frameSpeeches(view, day, 0).map((i) => i.kind)).toEqual(["speech", "last_words"]);
    expect(frameSpeech(view, day, 0)?.kind).toBe("last_words");
  });

  test("a replayed night keeps the action after the phase moved on", () => {
    const view = nightThenDay();
    const night = buildFrames(view, true).find((f) => f.id === "n1")!;
    const action = seatActionFor(view, night, 0);
    expect(action?.label).toBe("刀 7号");
    expect(action?.detail).toBe("先刀 7 号外置位");
  });

  test("a dead seat is never reported as speaking during the day", () => {
    let view = nightThenDay();
    view = applyWerewolfEvent(view, event(20, "seat.died", { seat: 0, cause: "vote", day: 1 }));
    view = applyWerewolfEvent(view, event(21, "exile", { day: 1, seat: 0 }));
    // A stale `speaking` pointer must not resurrect the dead seat.
    view = { ...view, speaking: 0 };
    const day = buildFrames(view, true).find((f) => f.id === "d1")!;
    const status = seatStatus(view, day, view.seats[0], "d1", true);
    expect(status.label).not.toBe("发言中");
    expect(status.label).toBe("被放逐");
  });

  test("old events without a reasoning channel fall back to the note only", () => {
    const view = nightThenDay();
    const thought = view.thinkingHistory.find((t) => t.seat === 1);
    expect(thought?.text).toBe("跟刀");
    expect(thought?.native).toBe("");
    expect(view.thinkingHistory.find((t) => t.seat === 0)?.native).toBe("native chain");
  });

  test("a night frame lists every decision round with its note", () => {
    const view = nightThenDay();
    const night = buildFrames(view, true).find((f) => f.id === "n1")!;
    const rounds = decisionRounds(view, night);
    expect(rounds.map((r) => r.phase)).toEqual(["night_wolves", "night_seer", "night_witch"]);
    expect(rounds[0].rows.map((r) => r.label)).toEqual(["刀 7号", "刀 7号"]);
    expect(rounds[0].rows[0].note).toBe("想刀 7 号");
    expect(rounds[1].rows[0].label).toBe("验 2号");
    expect(rounds[2].rows[0].label).toBe("解药");
  });

  test("a live vote shows all nine seats, the notes, and who has not voted", () => {
    const view = voteDay();
    const day = buildFrames(view, true).find((f) => f.id === "d1")!;
    const [round] = decisionRounds(view, day);
    expect(round.label).toBe("放逐投票");
    expect(round.rows).toHaveLength(9);
    expect(round.rows[0].status).toBe("thinking");
    expect(round.rows[0].note).toContain("这一票得压在");
    expect(round.rows[1].status).toBe("ready");
    expect(round.rows[1].label).toBe("投 1号");
    expect(round.rows[1].native).toBe("raw chain");
    expect(round.rows[8].status).toBe("waiting");
  });

  test("a seat's notes read in order: what it thought before speaking, then voting", () => {
    let view = voteDay();
    view = applyWerewolfEvent(
      view,
      event(33, "seat.submitted", {
        phase: "day_vote",
        seat: 0,
        content: { kind: "vote", target: 1 },
        thinking: "投票时的话",
      }),
    );
    const day = buildFrames(view, true).find((f) => f.id === "d1")!;
    const thoughts = frameThoughts(view, day, 0);
    expect(thoughts.map((t) => t.phase)).toEqual(["day_speech", "day_vote"]);
    expect(thoughts.map((t) => t.text)).toEqual(["白天发言", "投票时的话"]);
    expect(frameThought(view, day, 0)?.text).toBe("投票时的话");
  });

  test("an archived vote keeps its notes after the phase moves on", () => {
    let view = voteDay();
    view = applyWerewolfEvent(
      view,
      event(34, "seat.submitted", {
        phase: "day_vote",
        seat: 2,
        content: { kind: "vote", target: 1 },
        thinking: "跟票，先推 2 号。",
      }),
    );
    view = applyWerewolfEvent(view, event(35, "phase.changed", { day: 1, phase: "day_last_words" }));
    const day = buildFrames(view, true).find((f) => f.id === "d1")!;
    const [round] = decisionRounds(view, day);
    expect(round.rows.map((r) => r.seat)).toEqual([1, 2]);
    expect(round.rows.map((r) => r.status)).toEqual(["ready", "ready"]);
    expect(round.rows[1].note).toBe("跟票，先推 2 号。");
  });

  test("a seat's notes read in order: speaking, voting, then last words", () => {
    let view = voteDay();
    view = applyWerewolfEvent(
      view,
      event(36, "seat.submitted", {
        phase: "day_vote",
        seat: 0,
        content: { kind: "vote", target: 1 },
        thinking: "投票时的话",
      }),
    );
    view = applyWerewolfEvent(view, event(37, "phase.changed", { day: 1, phase: "day_last_words" }));
    view = applyWerewolfEvent(
      view,
      event(38, "seat.submitted", {
        phase: "day_last_words",
        seat: 0,
        content: { kind: "last_words", text: "遗言" },
        thinking: "遗言前的话",
      }),
    );
    const day = buildFrames(view, true).find((f) => f.id === "d1")!;
    expect(frameThoughts(view, day, 0).map((t) => t.phase)).toEqual([
      "day_speech",
      "day_vote",
      "day_last_words",
    ]);
    expect(frameThought(view, day, 0)?.text).toBe("遗言前的话");
  });

  test("a PK day reads speaking, first vote, PK speech, PK vote, last words", () => {
    let view = voteDay();
    view = applyWerewolfEvent(
      view,
      event(40, "seat.submitted", {
        phase: "day_vote",
        seat: 0,
        content: { kind: "vote", target: 1 },
        thinking: "第一票",
      }),
    );
    view = applyWerewolfEvent(view, event(41, "phase.changed", { day: 1, phase: "day_pk_speech" }));
    view = applyWerewolfEvent(
      view,
      event(42, "seat.submitted", {
        phase: "day_pk_speech",
        seat: 0,
        content: { kind: "speech", text: "PK 发言" },
        thinking: "PK 发言前",
      }),
    );
    view = applyWerewolfEvent(view, event(43, "phase.changed", { day: 1, phase: "day_pk_vote" }));
    view = applyWerewolfEvent(
      view,
      event(44, "seat.submitted", {
        phase: "day_pk_vote",
        seat: 0,
        content: { kind: "vote", target: 1 },
        thinking: "PK 投票时",
      }),
    );
    view = applyWerewolfEvent(view, event(45, "phase.changed", { day: 1, phase: "day_last_words" }));
    view = applyWerewolfEvent(
      view,
      event(46, "seat.submitted", {
        phase: "day_last_words",
        seat: 0,
        content: { kind: "last_words", text: "遗言" },
        thinking: "遗言前",
      }),
    );
    const day = buildFrames(view, true).find((f) => f.id === "d1")!;
    expect(frameThoughts(view, day, 0).map((t) => t.phase)).toEqual([
      "day_speech",
      "day_vote",
      "day_pk_speech",
      "day_pk_vote",
      "day_last_words",
    ]);
  });
});

describe("audience note hygiene", () => {
  test("strips a bare Markdown quote line but keeps a quoted sentence", () => {
    expect(cleanThinking(">\n\n我是9号狼人。")).toBe("我是9号狼人。");
    expect(cleanThinking(">\n> \n正文")).toBe("正文");
    expect(cleanThinking("> 引用\n正文")).toBe("> 引用\n正文");
    expect(cleanThinking("<<<THINK>>>\n>\n正文")).toBe("正文");
  });
});

describe("seat card labels", () => {
  test("a ballot reads as a target, an abstention, or no vote", () => {
    expect(seatBallot(6)).toBe("票 → 7号");
    expect(seatBallot("abstain")).toBe("票 → 弃");
    expect(seatBallot(null)).toBe("未投票");
  });

  test("a dead seat keeps its ballot instead of hiding it behind the death cause", () => {
    expect(seatCardMid({ dead: true, death: "vote", showRole: true, vote: 6 })).toBe("票 → 7号");
    expect(seatCardMid({ dead: true, death: "wolf", showRole: true, vote: null })).toBe("出局 · 狼刀");
    expect(seatCardMid({ dead: true, death: "vote", showRole: false, vote: null })).toBe("出局");
    expect(seatCardMid({ dead: false, death: null, showRole: true, vote: null })).toBe("未投票");
  });
});

describe("a dead process", () => {
  function nightOnly() {
    const roster = Array.from({ length: 9 }, (_, seat) => ({ id: `p${seat}`, seat, model: model(seat) }));
    let state = tableFromRoster(roster);
    state = applyWerewolfEvent(
      state,
      event(1, "match.created", {
        name: "预女猎九人局",
        tagline: "测试",
        maxDays: 8,
        briefing: "规则",
        seats: roster.map((p) => ({ participantId: p.id, seat: p.seat })),
      }),
    );
    state = applyWerewolfEvent(state, event(2, "phase.changed", { day: 1, phase: "night_wolves" }));
    // The last thing the log saw was a delta; then the process died.
    return applyWerewolfEvent(
      state,
      event(3, "seat.thinking.delta", { phase: "night_wolves", seat: 0, delta: "想着刀谁" }),
    );
  }

  test("a seat that was thinking reads 已中断 once the loop is gone", () => {
    const live = nightOnly();
    const night = buildFrames(live, true).find((f) => f.id === "n1")!;
    expect(seatStatus(live, night, live.seats[0], "n1", true).label).toBe("推演中");

    const stale = { ...live, live: false };
    expect(seatStatus(stale, night, stale.seats[0], "n1", true).label).toBe("已中断");
  });

  test("the current frame stops claiming the night is in progress", () => {
    const live = nightOnly();
    expect(buildFrames(live, true).find((f) => f.id === "n1")?.caption).toBe("夜间进行中");

    const stale = { ...live, live: false };
    const frame = buildFrames(stale, true).find((f) => f.id === "n1")!;
    expect(frame.caption).toBe("夜间 · 已中断");
    expect(frame.sub).toBe("已中断");
  });

  test("a seat that already answered keeps its fact, and a finished table wins", () => {
    const live = voteDay();
    const day = buildFrames(live, true).find((f) => f.id === "d1")!;
    const stale = { ...live, live: false };

    expect(seatStatus(stale, day, stale.seats[1], "d1", true).label).not.toBe("已中断");
    // `finished` outranks liveness: the end frame must not be relabelled.
    const done = { ...stale, finished: true };
    expect(buildFrames(done, true).find((f) => f.id === "d1")?.sub).toBe("公开记录");
  });
});
