import { describe, expect, test } from "bun:test";
import {
  applyWerewolfEvent,
  tableFromRoster,
} from "../src/components/WerewolfTable";
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

function boot() {
  const roster = Array.from({ length: 9 }, (_, seat) => ({
    id: `p${seat}`,
    seat,
    model: model(seat),
  }));
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
    event(3, "phase.changed", { day: 1, phase: "day_speech" }),
    event(4, "seat.thinking.delta", {
      phase: "day_speech",
      seat: 0,
      delta: "我先听一圈。",
    }),
    event(5, "speech", { day: 1, seat: 0, text: "1号发言。" }),
    event(6, "phase.changed", { day: 1, phase: "day_vote" }),
    event(7, "seat.submitted", { phase: "day_vote", seat: 0, content: { kind: "vote", target: 1 } }),
    event(8, "vote.tally", {
      day: 1,
      counts: { 1: 7, 2: 1 },
      votes: { 0: 1, 1: 1, 2: 2, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
      exiled: 1,
      tie: [],
    }),
    event(9, "exile", { day: 1, seat: 1 }),
    event(10, "match.finished", {
      winnerCamp: "good",
      winnerName: "好人阵营",
      reason: "wolves_out",
      day: 2,
      roles: ROLES.map((role, seat) => ({ seat, role, camp: role === "wolf" ? "wolf" : "good" })),
    }),
  ];
  for (const e of events) state = applyWerewolfEvent(state, e);
  return state;
}

describe("werewolf table reducer", () => {
  test("builds nine seats from the frozen roster", () => {
    const state = boot();
    expect(state.seats).toHaveLength(9);
    expect(state.seats[0].display).toBe("演练体 0");
    expect(state.seats[0].role).toBe("wolf");
    expect(state.seats[6].role).toBe("seer");
  });

  test("replays public facts into the chronicle", () => {
    const state = boot();
    expect(state.meta?.name).toBe("预女猎九人局");
    expect(state.publicLog.some((l) => l.text.includes("1号发言"))).toBe(true);
    expect(state.publicLog.some((l) => l.text.includes("2号被放逐"))).toBe(true);
    expect(state.votes[0]).toBe(1);
    expect(state.counts[1]).toBe(7);
  });

  test("a stale thinking delta from another phase is ignored", () => {
    let state = tableFromRoster(
      Array.from({ length: 9 }, (_, seat) => ({ id: `p${seat}`, seat, model: model(seat) })),
    );
    state = applyWerewolfEvent(state, event(1, "phase.changed", { day: 1, phase: "day_vote" }));
    state = applyWerewolfEvent(
      state,
      event(2, "seat.thinking.delta", { phase: "day_speech", seat: 0, delta: "旧阶段" }),
    );
    expect(state.seats[0].thinking).toBe("");
  });

  test("the final reveal carries every role and the winner", () => {
    const state = boot();
    expect(state.finished).toBe(true);
    expect(state.winner?.camp).toBe("good");
    expect(state.winner?.reason).toBe("wolves_out");
    expect(state.seats.every((s) => s.role !== null)).toBe(true);
    expect(state.publicLog.at(-1)?.text).toContain("好人阵营胜");
  });

  test("seat deaths and vote chips survive the phase reset", () => {
    const state = boot();
    expect(state.seats[1].alive).toBe(false);
    expect(state.seats[1].death?.cause).toBe("vote");
    expect(state.seats[0].vote).toBe(1);
  });
});
