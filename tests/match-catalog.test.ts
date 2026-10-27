import { describe, expect, test } from "bun:test";
import {
  clockLabel,
  dayKey,
  dayLabel,
  endReasonLabel,
  filterMatches,
  formatCount,
  groupByDay,
  kindCounts,
  matchHref,
  matchStatus,
  outcomeLabel,
  searchText,
  sortMatches,
  statusCounts,
  type CatalogMatch,
} from "../src/lib/match-catalog";

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime(); // 2026-10-24 12:00 local
const TODAY = new Date(2026, 9, 24, 9, 41, 0).getTime();
const YESTERDAY = new Date(2026, 9, 23, 23, 5, 0).getTime();
const OLD = new Date(2026, 9, 20, 8, 0, 0).getTime();
const LAST_YEAR = new Date(2025, 0, 3, 8, 0, 0).getTime();

function match(over: Partial<CatalogMatch> = {}): CatalogMatch {
  return {
    id: "m_alpha",
    rulesetName: "罐中论剑",
    seed: "c0ffee",
    status: "finished",
    format: "1v1",
    kind: "rubric",
    winnerTeamName: "青方",
    endReason: "rubric_total",
    createdAt: TODAY,
    finishedAt: TODAY,
    rounds: 6,
    resumable: false,
    tokensUsed: 12345,
    teams: [
      { id: "t1", name: "青方", color: "#37e0b0", total: 5.2 },
      { id: "t2", name: "红方", color: "#ff5a5a", total: 3.1 },
    ],
    ...over,
  };
}

describe("matchStatus", () => {
  test("separates a recoverable interrupted match from a dead one", () => {
    expect(matchStatus({ status: "interrupted", resumable: true })).toEqual({
      key: "resumable",
      label: "可继续",
      tone: "amber",
    });
    expect(matchStatus({ status: "interrupted", resumable: false })).toEqual({
      key: "interrupted",
      label: "已中断",
      tone: "blood",
    });
  });

  test("maps every terminal state the engine writes", () => {
    expect(matchStatus({ status: "running", resumable: false }).key).toBe("live");
    expect(matchStatus({ status: "finished", resumable: false }).key).toBe("finished");
    expect(matchStatus({ status: "aborted", resumable: false }).key).toBe("aborted");
    expect(matchStatus({ status: "failed", resumable: false }).key).toBe("failed");
  });

  test("keeps an unknown status readable instead of dropping the row", () => {
    expect(matchStatus({ status: "paused", resumable: false })).toEqual({
      key: "unknown",
      label: "paused",
      tone: "dim",
    });
  });
});

describe("matchHref", () => {
  test("routes each kind to its own replay surface", () => {
    expect(matchHref({ id: "m1", kind: "werewolf" })).toBe("/table/m1");
    expect(matchHref({ id: "m1", kind: "rubric" })).toBe("/arena/m1");
  });
});

describe("endReasonLabel", () => {
  test("translates engine tokens", () => {
    expect(endReasonLabel("wolves_out")).toBe("狼人全灭");
    expect(endReasonLabel("rubric_total")).toBe("总分决出");
    expect(endReasonLabel("forfeit_limit")).toBe("弃权判负");
  });

  test("cleans the aborted prefix", () => {
    expect(endReasonLabel("aborted:manual")).toBe("手动中止");
    expect(endReasonLabel("aborted:judge_failed")).toBe("中止 · 裁判失败");
  });

  test("keeps an unknown reason verbatim and accepts null", () => {
    expect(endReasonLabel("teleported")).toBe("teleported");
    expect(endReasonLabel(null)).toBeNull();
  });
});

describe("outcomeLabel", () => {
  test("prefers the winner name", () => {
    expect(outcomeLabel(match())).toBe("青方胜");
  });

  test("does not invent a winner", () => {
    expect(outcomeLabel(match({ winnerTeamName: null, status: "finished" }))).toBe("无胜者");
    expect(outcomeLabel(match({ winnerTeamName: null, status: "running" }))).toBe("进行中");
    expect(outcomeLabel(match({ winnerTeamName: null, status: "aborted" }))).toBe("已中止");
  });
});

describe("search and filters", () => {
  const corpus = [
    match({ id: "m_rubric", createdAt: TODAY, seed: "aaaa1111" }),
    match({
      id: "m_wolf",
      kind: "werewolf",
      rulesetName: "预女猎九人局",
      format: "9人",
      seed: "bbbb2222",
      winnerTeamName: "狼人阵营",
      endReason: "wolves_out",
      createdAt: YESTERDAY,
      teams: [
        { id: "w1", name: "狼人阵营", color: "#ff5a5a", total: 0 },
        { id: "w2", name: "好人阵营", color: "#37e0b0", total: 0 },
      ],
    }),
    match({
      id: "m_dead",
      status: "interrupted",
      resumable: true,
      winnerTeamName: null,
      endReason: null,
      createdAt: OLD,
      teams: [{ id: "d1", name: "好人阵营", color: "#37e0b0", total: 0 }],
    }),
    match({
      id: "m_gone",
      status: "interrupted",
      resumable: false,
      winnerTeamName: null,
      endReason: null,
      createdAt: OLD - 1000,
      teams: [{ id: "g1", name: "狼人阵营", color: "#ff5a5a", total: 0 }],
    }),
  ];

  test("matches on seeds, teams, ids and case-insensitively", () => {
    expect(filterMatches(corpus, { query: "AAAA1111" }).map((m) => m.id)).toEqual(["m_rubric"]);
    expect(filterMatches(corpus, { query: "红方" }).map((m) => m.id)).toEqual(["m_rubric"]);
    expect(filterMatches(corpus, { query: "m_wolf" }).map((m) => m.id)).toEqual(["m_wolf"]);
  });

  test("requires every token to hit the same row", () => {
    expect(filterMatches(corpus, { query: "九人 狼人" }).map((m) => m.id)).toEqual(["m_wolf"]);
    expect(filterMatches(corpus, { query: "九人 罐中" })).toEqual([]);
  });

  test("finds matches by the Chinese status label", () => {
    expect(filterMatches(corpus, { query: "可继续" }).map((m) => m.id)).toEqual(["m_dead"]);
  });

  test("filters by kind and by status key", () => {
    expect(filterMatches(corpus, { kind: "werewolf" }).map((m) => m.id)).toEqual(["m_wolf"]);
    expect(filterMatches(corpus, { status: "resumable" }).map((m) => m.id)).toEqual(["m_dead"]);
    expect(filterMatches(corpus, { status: "interrupted" }).map((m) => m.id)).toEqual(["m_gone"]);
    expect(filterMatches(corpus, { status: "finished" }).map((m) => m.id)).toEqual([
      "m_rubric",
      "m_wolf",
    ]);
  });

  test("combines query, kind and status", () => {
    expect(filterMatches(corpus, { query: "预女猎", kind: "werewolf", status: "finished" })).toHaveLength(1);
    expect(filterMatches(corpus, { query: "预女猎", kind: "rubric" })).toEqual([]);
  });

  test("an empty query keeps everything", () => {
    expect(filterMatches(corpus, { query: "   " })).toHaveLength(corpus.length);
  });
});

describe("searchText", () => {
  test("carries the readable date so 10/23 still finds the row", () => {
    const text = searchText(match({ createdAt: YESTERDAY }));
    expect(text).toContain("10/23");
    expect(text).toContain(dayKey(YESTERDAY));
    expect(text).toContain("罐中论剑");
    expect(text).toContain("已结束");
  });
});

describe("sortMatches", () => {
  const a = match({ id: "a", createdAt: TODAY, rounds: 3, tokensUsed: 900 });
  const b = match({ id: "b", createdAt: YESTERDAY, rounds: 9, tokensUsed: 100 });
  const c = match({ id: "c", createdAt: OLD, rounds: 9, tokensUsed: 5000 });

  test("newest and oldest follow the creation clock", () => {
    expect(sortMatches([b, c, a], "newest").map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(sortMatches([b, c, a], "oldest").map((m) => m.id)).toEqual(["c", "b", "a"]);
  });

  test("rounds break ties by the newer match", () => {
    expect(sortMatches([a, c, b], "rounds").map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  test("tokens break ties by the newer match", () => {
    expect(sortMatches([a, b, c], "tokens").map((m) => m.id)).toEqual(["c", "a", "b"]);
  });

  test("does not mutate the input", () => {
    const input = [b, a, c];
    sortMatches(input, "newest");
    expect(input.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });
});

describe("day buckets", () => {
  test("labels today, yesterday and older days", () => {
    expect(dayLabel(TODAY, NOW)).toBe("今天");
    expect(dayLabel(YESTERDAY, NOW)).toBe("昨天");
    expect(dayLabel(OLD, NOW)).toBe("10月20日 · 周二");
    expect(dayLabel(LAST_YEAR, NOW)).toBe("2025年1月3日 · 周五");
  });

  test("groups in encounter order and keeps every item", () => {
    const groups = groupByDay(
      [
        match({ id: "a", createdAt: TODAY }),
        match({ id: "b", createdAt: YESTERDAY }),
        match({ id: "c", createdAt: YESTERDAY }),
        match({ id: "d", createdAt: OLD }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "10月20日 · 周二"]);
    expect(groups.map((g) => g.items.map((m) => m.id))).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  test("day keys use the local calendar, not UTC", () => {
    expect(dayKey(new Date(2026, 0, 1, 0, 30).getTime())).toBe("2026-01-01");
    expect(dayKey(new Date(2026, 11, 31, 23, 59).getTime())).toBe("2026-12-31");
  });
});

describe("counts and formatting", () => {
  test("status counts add up to the corpus size", () => {
    const counts = statusCounts([
      match({ status: "finished" }),
      match({ status: "running" }),
      match({ status: "interrupted", resumable: true }),
      match({ status: "interrupted", resumable: false }),
      match({ status: "aborted" }),
    ]);
    expect(counts.finished).toBe(1);
    expect(counts.live).toBe(1);
    expect(counts.resumable).toBe(1);
    expect(counts.interrupted).toBe(1);
    expect(counts.aborted).toBe(1);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(5);
  });

  test("kind counts split the three game types", () => {
    expect(kindCounts([match(), match({ kind: "werewolf" }), match({ kind: "werewolf" })])).toEqual({
      rubric: 1,
      werewolf: 2,
      coup: 0,
    });
  });

  test("clock and counts are padded and grouped", () => {
    expect(clockLabel(new Date(2026, 9, 24, 9, 5).getTime())).toBe("09:05");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});
