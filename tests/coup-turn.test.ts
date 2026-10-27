import { describe, expect, test } from "bun:test";
import {
  applyTurnEvent,
  describeTurn,
  describeTurnSteps,
  emptyTurn,
  isBluff,
  turnOutcome,
  type CoupTurnRecord,
} from "../src/engine/coup/turn";
import type { ArenaEvent, EventType } from "../src/engine/types";

let seq = 0;
function ev(type: EventType, payload: Record<string, unknown>, seat?: number): ArenaEvent {
  return { seq: ++seq, type, ts: 0, ...(seat === undefined ? {} : { seat }), payload };
}

function fold(events: ArenaEvent[], start: CoupTurnRecord = emptyTurn()): CoupTurnRecord {
  return events.reduce(applyTurnEvent, start);
}

describe("one turn, folded from events", () => {
  test("claim, reactions, challenge and the cost all land in one record", () => {
    const record = fold([
      ev("coup.action", {
        turn: 3,
        seat: 2,
        action: "steal",
        role: "captain",
        target: 1,
        say: "借你两枚。",
        note: "我手上没有队长，赌他们不敢质疑。",
        honest: false,
        paid: 0,
        challengeable: true,
        blockable: true,
      }),
      ev("coup.reaction", { turn: 3, seat: 0, kind: "pass", as: null, say: "先看看", note: "" }),
      ev("coup.reaction", { turn: 3, seat: 1, kind: "challenge", as: null, say: "你没有队长", note: "" }),
      ev("coup.challenge", { turn: 3, challenger: 1, target: 2, holds: false, role: "captain", about: "claim" }),
      ev("coup.lost", { turn: 3, seat: 2, role: "assassin", cause: "challenge_failed", remaining: 1 }),
      ev("coup.coins", { turn: 3, coins: [{ seat: 2, coins: 2, before: 5 }] }),
    ]);

    expect(record.actor).toBe(2);
    expect(record.target).toBe(1);
    expect(record.honest).toBe(false);
    expect(isBluff(record)).toBe(true);
    expect(record.reactions).toHaveLength(2);
    expect(record.challenge?.holds).toBe(false);
    expect(record.lost).toHaveLength(1);
    expect(record.coins[0]).toEqual({ seat: 2, coins: 2, before: 5 });
    expect(turnOutcome(record)).toBe("voided");

    const n = describeTurn(record);
    expect(n.claim).toBe("3 号 → 2 号 · 偷窃（队长）");
    expect(n.headline).toBe("质疑成立，行动作废");
    expect(n.truth).toContain("诈唬");
    expect(n.say).toBe("「借你两枚。」");
    expect(n.reactions[1]?.text).toContain("2 号 质疑");
    expect(n.results.join(" ")).toContain("质疑成立");
    expect(n.results.join(" ")).toContain("3 号 5 → 2 枚");
  });

  test("a successful block is reported as blocked", () => {
    const record = fold([
      ev("coup.action", {
        turn: 4,
        seat: 0,
        action: "assassinate",
        role: "assassin",
        target: 1,
        say: "",
        note: "",
        honest: true,
        paid: 3,
      }),
      ev("coup.reaction", { turn: 4, seat: 1, kind: "block", as: "contessa", say: "我有夫人", note: "" }),
      ev("coup.block", { turn: 4, seat: 1, as: "contessa", say: "我有夫人", note: "" }),
      ev("coup.reaction", { turn: 4, seat: 2, kind: "challenge", as: null, say: "我不信", about: "block" }),
      ev("coup.challenge", { turn: 4, challenger: 2, target: 1, holds: true, role: "contessa", about: "block" }),
    ]);
    expect(turnOutcome(record)).toBe("blocked");
    expect(describeTurn(record).headline).toBe("阻挡成立，行动失败");
    const n = describeTurn(record);
    expect(n.results.join(" ")).toContain("质疑阻挡失败");
    expect(n.results.join(" ")).toContain("被挡下");
  });

  test("a new claim wipes the previous draft instead of merging two turns", () => {
    const first = fold([
      ev("coup.action", { turn: 1, seat: 0, action: "tax", role: "duke", target: null, say: "", honest: true }),
      ev("coup.reaction", { turn: 1, seat: 1, kind: "challenge", as: null, say: "不信", note: "" }),
    ]);
    const second = applyTurnEvent(
      first,
      ev("coup.action", { turn: 2, seat: 1, action: "income", role: null, target: null, say: "", honest: null }),
    );
    expect(second.turn).toBe(2);
    expect(second.actor).toBe(1);
    expect(second.reactions).toHaveLength(0);
    expect(second.challenge).toBeNull();
  });

  test("events outside a turn keep the same object", () => {
    const record = emptyTurn(1);
    expect(applyTurnEvent(record, ev("match.created", {}))).toBe(record);
    expect(applyTurnEvent(record, ev("coup.dealt", {}))).toBe(record);
    expect(applyTurnEvent(record, ev("seat.thinking.delta", { seat: 0, delta: "x", channel: "note" }))).toBe(record);
  });

  test("every balance change is kept in order, including a refund", () => {
    const record = fold([
      ev("coup.action", { turn: 2, seat: 0, action: "tax", role: "duke", target: null, say: "", honest: true, paid: 0 }),
      ev("coup.coins", { turn: 2, coins: [{ seat: 0, coins: 5, before: 2 }] }),
      ev("coup.coins", { turn: 2, coins: [{ seat: 0, coins: 2, before: 5 }] }),
      ev("coup.coins", { turn: 2, coins: [{ seat: 0, coins: 5, before: 2 }] }),
    ]);
    expect(record.coins).toEqual([
      { seat: 0, coins: 5, before: 2 },
      { seat: 0, coins: 2, before: 5 },
      { seat: 0, coins: 5, before: 2 },
    ]);
    expect(describeTurn(record).results.filter((line) => line.includes("枚")).length).toBe(3);
  });
});

describe("forfeits are narrated, never disguised", () => {
  test("a forfeited income is labelled as a fallback", () => {
    const record = fold([
      ev("coup.action", {
        turn: 2,
        seat: 1,
        action: "income",
        role: null,
        target: null,
        say: "",
        note: "我本想征税。",
        honest: null,
        forfeit: true,
        anomalies: ["invalid_move"],
      }),
      ev("coup.forfeit", { turn: 2, seat: 1, phase: "action_select", anomalies: ["invalid_move"] }),
    ]);
    expect(record.forfeits).toHaveLength(1);
    const n = describeTurn(record);
    expect(n.forfeits[0]).toContain("没有交出合法答案");
    expect(n.forfeits[0]).toContain("按「收入」处理");
    expect(n.forfeits[0]).toContain("动作不合法");
  });

  test("a pass that was really a forfeit carries the marker", () => {
    const record = fold([
      ev("coup.action", {
        turn: 2,
        seat: 1,
        action: "tax",
        role: "duke",
        target: null,
        say: "",
        note: "",
        honest: true,
      }),
      ev("coup.reaction", {
        turn: 2,
        seat: 3,
        kind: "pass",
        as: null,
        say: "",
        note: "",
        forfeit: true,
        anomalies: ["no_reaction"],
      }),
    ]);
    const n = describeTurn(record);
    expect(n.reactions[0]?.text).toContain("弃权");
  });
});

describe("one turn, unrolled into a timeline", () => {
  test("the steps keep the order things happened in", () => {
    const record = fold([
      ev("coup.action", {
        turn: 3,
        seat: 2,
        action: "steal",
        role: "captain",
        target: 1,
        say: "借你两枚。",
        note: "我手上没有队长，赌他们不敢质疑。",
        honest: false,
        paid: 0,
        challengeable: true,
        blockable: true,
      }),
      ev("coup.reaction", { turn: 3, seat: 0, kind: "pass", as: null, say: "先看看", note: "不关我事" }),
      ev("coup.reaction", { turn: 3, seat: 1, kind: "challenge", as: null, say: "你没有队长", note: "他刚才换过牌" }),
      ev("coup.challenge", { turn: 3, challenger: 1, target: 2, holds: false, role: "captain" }),
      ev("coup.lost", { turn: 3, seat: 2, role: "assassin", cause: "challenge_failed", remaining: 1 }),
      ev("coup.coins", { turn: 3, coins: [{ seat: 2, coins: 2, before: 5 }] }),
    ]);
    const steps = describeTurnSteps(record);
    expect(steps.map((s) => s.label)).toEqual(["宣称", "放过", "质疑", "结质疑", "掉命", "金币"]);
    expect(steps[0]!.note).toContain("赌他们不敢质疑");
    expect(steps[1]!.note).toBe("不关我事");
    expect(steps[2]!.note).toBe("他刚才换过牌");
    expect(steps[3]!.text).toContain("质疑成立");
    expect(steps[5]!.text).toBe("3 号 5 → 2 枚");
  });

  test("a block is its own step, never a duplicate reaction", () => {
    const record = fold([
      ev("coup.action", {
        turn: 4,
        seat: 0,
        action: "assassinate",
        role: "assassin",
        target: 1,
        say: "",
        note: "",
        honest: true,
        paid: 3,
        challengeable: true,
        blockable: true,
      }),
      ev("coup.reaction", { turn: 4, seat: 1, kind: "block", as: "contessa", say: "我有夫人", note: "我其实没有" }),
      ev("coup.block", { turn: 4, seat: 1, as: "contessa", say: "我有夫人", note: "我其实没有" }),
      ev("coup.reaction", { turn: 4, seat: 2, kind: "challenge", as: null, say: "不信", note: "", about: "block" }),
    ]);
    const steps = describeTurnSteps(record);
    expect(steps.filter((s) => s.kind === "block")).toHaveLength(1);
    expect(steps.find((s) => s.kind === "block")!.note).toBe("我其实没有");
    expect(steps.filter((s) => s.label === "质疑阻挡")).toHaveLength(1);
    expect(steps.filter((s) => s.label === "放过")).toHaveLength(0);
  });

  test("a forfeit is spelled out instead of being read as a choice", () => {
    const record = fold([
      ev("coup.action", {
        turn: 5,
        seat: 0,
        action: "income",
        role: null,
        target: null,
        say: "",
        note: "",
        honest: null,
        paid: 0,
        challengeable: false,
        blockable: false,
      }),
      ev("coup.forfeit", { turn: 5, seat: 3, phase: "action_reaction", anomalies: ["no_reaction"] }),
    ]);
    const steps = describeTurnSteps(record);
    const forfeit = steps.find((s) => s.kind === "forfeit");
    expect(forfeit?.text).toContain("没有交出合法答案");
    expect(forfeit?.text).toContain("按「放过」处理");
  });
});
