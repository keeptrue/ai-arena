import { describe, expect, test } from "bun:test";
import {
  applyCoupEvent,
  bluffCount,
  coupFrameFromRoster,
  emptyCoupFrame,
  phaseText,
  replayCoup,
  type CoupFrame,
} from "../src/lib/coup-frame";
import type { ArenaEvent, EventType } from "../src/engine/types";

let seq = 0;
function ev(type: EventType, payload: Record<string, unknown>, seat?: number): ArenaEvent {
  return { seq: ++seq, type, ts: 0, ...(seat === undefined ? {} : { seat }), payload };
}

function frameWithSeats(): CoupFrame {
  return coupFrameFromRoster("m_test", "测试桌", [
    { seat: 0, display: "甲" },
    { seat: 1, display: "乙" },
    { seat: 2, display: "丙" },
    { seat: 3, display: "丁" },
  ]);
}

function boot(): CoupFrame {
  const frame = frameWithSeats();
  const events: ArenaEvent[] = [
    ev("coup.dealt", {
      deck: 7,
      hands: [0, 1, 2, 3].map((seat) => ({
        seat,
        cards: [
          { id: `c${seat}a`, role: seat === 0 ? "captain" : "duke" },
          { id: `c${seat}b`, role: "contessa" },
        ],
      })),
      coins: [0, 1, 2, 3].map((seat) => ({ seat, coins: 2 })),
    }),
    ev("phase.changed", { phase: "action_select", queue: [0], mode: "sequential" }),
    ev("coup.turn", { turn: 1, actor: 0, forcedCoup: false, coins: [0, 1, 2, 3].map((seat) => ({ seat, coins: 2 })), deck: 7, alive: [0, 1, 2, 3] }),
  ];
  for (const event of events) applyCoupEvent(frame, event);
  return frame;
}

describe("coup frame", () => {
  test("a settled turn lands in the timeline when the next turn opens", () => {
    const frame = boot();
    const events: ArenaEvent[] = [
      ev("coup.action", {
        turn: 1,
        seat: 0,
        action: "steal",
        role: "captain",
        target: 2,
        say: "借两枚。",
        note: "我其实有队长。",
        honest: true,
        paid: 0,
        challengeable: true,
        blockable: true,
        coinsAfter: 2,
      }),
      ev("phase.changed", { phase: "action_reaction", queue: [1, 2, 3], mode: "parallel" }),
      ev("coup.reaction", { turn: 1, seat: 1, kind: "pass", as: null, say: "先看看", note: "不关我事" }),
      ev("coup.reaction", { turn: 1, seat: 2, kind: "challenge", as: null, say: "你没有队长", note: "" }, 2),
      ev("coup.challenge", { turn: 1, challenger: 2, target: 0, holds: true, role: "captain", about: "claim" }),
      ev("coup.lost", { turn: 1, seat: 2, role: "duke", cause: "challenge_lost", remaining: 1 }),
      ev("coup.coins", { turn: 1, coins: [{ seat: 2, coins: 2, before: 2 }] }),
      ev("coup.turn", { turn: 2, actor: 1, coins: [0, 1, 2, 3].map((seat) => ({ seat, coins: 2 })), deck: 7, alive: [0, 1, 2, 3] }),
    ];
    for (const event of events) applyCoupEvent(frame, event);

    expect(frame.current).toBeNull();
    expect(frame.turns).toHaveLength(1);
    const turn = frame.turns[0]!;
    expect(turn.actor).toBe(0);
    expect(turn.target).toBe(2);
    expect(turn.honest).toBe(true);
    expect(turn.note).toBe("我其实有队长。");
    expect(turn.reactions.map((r) => r.kind)).toEqual(["pass", "challenge"]);
    expect(turn.reactions[0]!.note).toBe("不关我事");
    expect(turn.challenge?.holds).toBe(true);
    expect(turn.lost[0]).toEqual({ seat: 2, role: "duke", cause: "challenge_lost", remaining: 1 });
    expect(frame.turn).toBe(2);
    expect(frame.actor).toBe(1);
    expect(frame.waiting).toEqual([1]);
  });

  test("a forfeit stays on the turn in flight", () => {
    const frame = boot();
    applyCoupEvent(
      frame,
      ev("coup.action", {
        turn: 1,
        seat: 0,
        action: "income",
        role: null,
        target: null,
        say: "",
        note: "我本想征税。",
        honest: null,
        forfeit: true,
        anomalies: ["invalid_move"],
      }),
    );
    applyCoupEvent(frame, ev("coup.forfeit", { turn: 1, seat: 0, phase: "action_select", anomalies: ["invalid_move"] }));
    expect(frame.current?.forfeits).toHaveLength(1);
    expect(frame.current?.forfeits[0]?.anomalies).toEqual(["invalid_move"]);
  });

  test("the native reasoning channel never reaches the audience note", () => {
    const frame = boot();
    applyCoupEvent(frame, ev("seat.thinking.delta", { seat: 0, delta: "We need decide", channel: "reason" }, 0));
    expect(frame.seats[0]!.note).toBe("");
    applyCoupEvent(frame, ev("seat.thinking.delta", { seat: 0, delta: "我先诈唬", channel: "note" }, 0));
    expect(frame.seats[0]!.note).toBe("我先诈唬");
  });

  test("a new phase clears the note of the seats it calls", () => {
    const frame = boot();
    applyCoupEvent(frame, ev("seat.thinking.delta", { seat: 1, delta: "旧的一手", channel: "note" }, 1));
    applyCoupEvent(frame, ev("phase.changed", { phase: "action_reaction", queue: [1, 2, 3], mode: "parallel" }));
    expect(frame.seats[1]!.note).toBe("");
  });

  test("an old action without an honest flag stays unlabelled, never a false 'true'", () => {
    const frame = boot();
    applyCoupEvent(
      frame,
      ev("coup.action", {
        turn: 1,
        seat: 0,
        action: "tax",
        role: "duke",
        target: null,
        say: "",
        paid: 0,
        challengeable: true,
        blockable: false,
        coinsAfter: 2,
      }),
    );
    expect(frame.current?.honest).toBeNull();
    expect(frame.current?.action).toBe("tax");
  });

  test("commentary attaches to the turn it narrates, even when it lands late", () => {
    const frame = boot();
    applyCoupEvent(
      frame,
      ev("coup.action", { turn: 1, seat: 0, action: "income", role: null, target: null, say: "", honest: null }),
    );
    applyCoupEvent(frame, ev("coup.turn", { turn: 2, actor: 1, deck: 7, coins: [], alive: [0, 1, 2, 3] }));
    applyCoupEvent(frame, ev("coup.commentary", { turn: 1, text: "1 号先收一枚。" }));
    expect(frame.turns[0]!.commentary).toBe("1 号先收一枚。");
    expect(frame.commentary?.text).toBe("1 号先收一枚。");

    // A second commentary for the next turn must not overwrite the first card.
    applyCoupEvent(frame, ev("coup.commentary", { turn: 2, text: "2 号也收一枚。" }));
    expect(frame.turns[0]!.commentary).toBe("1 号先收一枚。");
    expect(frame.commentaries).toHaveLength(2);
  });

  test("bluff count only counts claims the engine flagged", () => {
    const frame = boot();
    applyCoupEvent(
      frame,
      ev("coup.action", { turn: 1, seat: 0, action: "tax", role: "duke", target: null, say: "", honest: false }),
    );
    applyCoupEvent(frame, ev("coup.turn", { turn: 2, actor: 1, deck: 7, coins: [], alive: [0, 1, 2, 3] }));
    applyCoupEvent(
      frame,
      ev("coup.action", { turn: 2, seat: 1, action: "income", role: null, target: null, say: "", honest: null }),
    );
    applyCoupEvent(frame, ev("coup.turn", { turn: 3, actor: 2, deck: 7, coins: [], alive: [0, 1, 2, 3] }));
    expect(bluffCount(frame, 0)).toBe(1);
    expect(bluffCount(frame, 1)).toBe(0);
  });

  test("waiting shrinks as reactions land and names the right seat", () => {
    const frame = boot();
    applyCoupEvent(
      frame,
      ev("coup.action", { turn: 1, seat: 0, action: "tax", role: "duke", target: null, say: "", honest: true }),
    );
    applyCoupEvent(frame, ev("phase.changed", { phase: "action_reaction", queue: [1, 2, 3], mode: "parallel" }));
    expect(phaseText(frame)).toContain("表态");
    expect(phaseText(frame)).toContain("2 号、3 号、4 号");
    applyCoupEvent(frame, ev("coup.reaction", { turn: 1, seat: 1, kind: "pass", as: null, say: "", note: "" }));
    expect(frame.waiting).toEqual([2, 3]);
    expect(phaseText(frame)).toContain("3 号、4 号");
  });

  test("replaying a dump equals applying it live", () => {
    const events: ArenaEvent[] = [
      ev("coup.dealt", { deck: 7, hands: [{ seat: 0, cards: [{ id: "a", role: "duke" }] }], coins: [{ seat: 0, coins: 2 }] }),
      ev("coup.turn", { turn: 1, actor: 0, deck: 7, coins: [{ seat: 0, coins: 2 }] }),
      ev("coup.action", { turn: 1, seat: 0, action: "income", role: null, target: null, say: "", honest: null }),
      ev("coup.finished", { winner: 0, reason: "last_standing", coins: [{ seat: 0, coins: 3 }] }),
    ];
    const base = frameWithSeats();
    const replayed = replayCoup(events, base);
    expect(replayed.finished).toBe(true);
    expect(replayed.winner).toBe(0);
    expect(replayed.turns).toHaveLength(1);
    expect(replayed.seats[0]!.coins).toBe(3);
  });

  test("an empty frame renders a waiting label without throwing", () => {
    const frame = emptyCoupFrame("m_empty");
    expect(phaseText(frame)).toBe("发牌中");
    expect(frame.turns).toEqual([]);
  });
});

describe("the audience note is never shortened", () => {
  const action = (note: string): ArenaEvent =>
    ev("coup.action", {
      turn: 1,
      seat: 0,
      action: "income",
      role: null,
      target: null,
      say: "",
      note,
      honest: null,
      paid: 0,
      challengeable: false,
      blockable: false,
    });

  test("a live stream longer than the clipped copy survives the landing", () => {
    const frame = boot();
    const live = "他在算这一手值不值。".repeat(40);
    applyCoupEvent(frame, ev("seat.thinking.delta", { seat: 0, delta: live, channel: "note" }, 0));
    applyCoupEvent(frame, action(live.slice(0, 300)));
    expect(frame.seats[0]!.note.length).toBeGreaterThan(300);
  });

  test("the landed copy wins when it says more than the stream", () => {
    const frame = boot();
    applyCoupEvent(frame, ev("seat.thinking.delta", { seat: 0, delta: "短", channel: "note" }, 0));
    applyCoupEvent(frame, action("落地这一版更长一些，因为模型先写完了 JSON。"));
    expect(frame.seats[0]!.note).toBe("落地这一版更长一些，因为模型先写完了 JSON。");
  });

  test("a reaction note follows the same rule", () => {
    const frame = boot();
    applyCoupEvent(frame, ev("seat.thinking.delta", { seat: 1, delta: "我在等他亮牌。".repeat(20), channel: "note" }, 1));
    applyCoupEvent(frame, ev("coup.reaction", { turn: 1, seat: 1, kind: "pass", as: null, say: "", note: "短版" }));
    expect(frame.seats[1]!.note.length).toBeGreaterThan(100);
  });
});
