import { describe, expect, test } from "bun:test";
import { pickLineups, resolveLineup } from "../src/lib/lineup";
import type { LineupPoolModel, LineupRecord, LineupSeat, LineupTeam } from "../src/lib/lineup";

const pool: LineupPoolModel[] = [
  { id: "m1", providerId: "p1", modelId: "gpt", display: "GPT-5" },
  { id: "m2", providerId: "p2", modelId: "claude", display: "Claude 4.5" },
  { id: "m3", providerId: "p1", modelId: "o3", display: "o3" },
];

function seat(providerId: string, modelId: string, display = modelId): LineupSeat {
  return { providerId, modelId, display };
}

function team(name: string, seats: LineupSeat[], color = "#ff6b52"): LineupTeam {
  return { name, color, seats };
}

function record(matchId: string, createdAt: number, teams: LineupTeam[]): LineupRecord {
  return { matchId, createdAt, teams };
}

const duel = (matchId: string, createdAt: number) =>
  record(matchId, createdAt, [
    team("赤方", [seat("p1", "gpt", "Old GPT")]),
    team("青方", [seat("p2", "claude", "Old Claude")], "#2fd3a8"),
  ]);

describe("resolveLineup", () => {
  test("maps snapshots onto current model rows by provider + model string", () => {
    const resolved = resolveLineup(duel("m_a", 1), pool);
    expect(resolved.usable).toBe(true);
    expect(resolved.issues).toEqual([]);
    expect(resolved.teams.map((t) => t.modelIds)).toEqual([["m1"], ["m2"]]);
    expect(resolved.teams.map((t) => t.missing)).toEqual([[], []]);
  });

  test("a renamed display does not break the mapping", () => {
    const renamed = [...pool];
    renamed[0] = { ...renamed[0], display: "GPT-5.1" };
    const resolved = resolveLineup(duel("m_a", 1), renamed);
    expect(resolved.usable).toBe(true);
    expect(resolved.teams[0].modelIds).toEqual(["m1"]);
  });

  test("a seat that no longer resolves blocks the roster and keeps its old name", () => {
    const shrunk = pool.filter((m) => m.id !== "m2");
    const resolved = resolveLineup(duel("m_a", 1), shrunk);
    expect(resolved.usable).toBe(false);
    expect(resolved.teams[1].modelIds).toEqual([]);
    expect(resolved.teams[1].missing).toEqual(["Old Claude"]);
    expect(resolved.issues).toContainEqual({ code: "model_missing", detail: "Old Claude" });
  });

  test("an empty side or a lone side is not a roster", () => {
    const emptySide = record("m_b", 2, [team("赤方", [seat("p1", "gpt")]), team("青方", [])]);
    expect(resolveLineup(emptySide, pool).issues).toContainEqual({ code: "roster_invalid", detail: "青方" });

    const loneSide = record("m_c", 3, [team("赤方", [seat("p1", "gpt")])]);
    expect(resolveLineup(loneSide, pool).usable).toBe(false);
    expect(resolveLineup(loneSide, pool).issues).toContainEqual({ code: "roster_invalid" });
  });
});

describe("pickLineups", () => {
  test("offers the newest match when it still resolves", () => {
    const picked = pickLineups([duel("m_new", 30), duel("m_old", 20)], pool);
    expect(picked.latest?.matchId).toBe("m_new");
    expect(picked.restorable?.matchId).toBe("m_new");
  });

  test("skips ahead to an older roster that still resolves", () => {
    const gone = record("m_new", 30, [team("赤方", [seat("p9", "ghost", "已删模型")]), team("青方", [seat("p2", "claude")])]);
    const picked = pickLineups([gone, duel("m_old", 20)], pool);
    expect(picked.latest?.matchId).toBe("m_new");
    expect(picked.restorable?.matchId).toBe("m_old");
  });

  test("repeated identical rosters are folded instead of scanned twice", () => {
    const gone = record("m_new", 30, [team("赤方", [seat("p9", "ghost", "已删模型")]), team("青方", [seat("p2", "claude")])]);
    const same = { ...gone, matchId: "m_dup", createdAt: 25 };
    const picked = pickLineups([gone, same, duel("m_old", 20)], pool);
    expect(picked.restorable?.matchId).toBe("m_old");
  });

  test("nothing usable leaves the roster empty", () => {
    const gone = record("m_new", 30, [team("赤方", [seat("p9", "ghost", "已删模型")]), team("青方", [seat("p2", "claude")])]);
    const picked = pickLineups([gone], pool);
    expect(picked.latest?.matchId).toBe("m_new");
    expect(picked.restorable).toBeNull();
  });

  test("no history means no card", () => {
    expect(pickLineups([], pool)).toEqual({ latest: null, restorable: null });
  });
});
