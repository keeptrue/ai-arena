/**
 * Pure selectors behind the match library.
 *
 * One vocabulary for labels, search, filters, sorting and day buckets, shared by the
 * header menu, the "所有对局" page and the tests. Nothing here touches React, SQL or
 * the clock: `now` is always injected so the server render and the client hydration
 * group matches into identical day buckets.
 */
import type { GameKind } from "@/engine/types";

/** Structural subset of `MatchSummary`; extra columns on a summary are welcome. */
export interface CatalogMatch {
  id: string;
  rulesetName: string;
  seed: string;
  status: string;
  format: string;
  kind: GameKind;
  winnerTeamName: string | null;
  endReason: string | null;
  createdAt: number;
  finishedAt: number | null;
  rounds: number;
  resumable: boolean;
  tokensUsed: number;
  /** Optional so older callers that only build the minimal shape keep compiling. */
  cachedTokens?: number;
  teams: Array<{ id: string; name: string; color: string; total: number }>;
}

/**
 * Share of the token total a prefix cache served, as a whole percent.
 * Null when nothing hit — a "0%" badge on every old match is noise, not information.
 */
export function cacheHitPercent(match: { tokensUsed: number; cachedTokens?: number }): number | null {
  const cached = match.cachedTokens ?? 0;
  if (cached <= 0 || match.tokensUsed <= 0) return null;
  return Math.round((cached / match.tokensUsed) * 100);
}

export type MatchStatusKey =
  | "live"
  | "resumable"
  | "interrupted"
  | "failed"
  | "aborted"
  | "finished"
  | "unknown";

export type StatusTone = "jade" | "amber" | "blood" | "dim";

export interface MatchStatusMeta {
  key: MatchStatusKey;
  label: string;
  tone: StatusTone;
}

export type KindFilter = "all" | GameKind;
export type StatusFilter = "all" | MatchStatusKey;

export type MatchSort = "newest" | "oldest" | "rounds" | "tokens";

/** Chip order: what is still running or recoverable outranks the archive. */
export const STATUS_ORDER: MatchStatusKey[] = [
  "live",
  "resumable",
  "interrupted",
  "failed",
  "aborted",
  "finished",
  "unknown",
];

export const STATUS_LABELS: Record<MatchStatusKey, string> = {
  live: "进行中",
  resumable: "可继续",
  interrupted: "已中断",
  failed: "已失败",
  aborted: "已中止",
  finished: "已结束",
  unknown: "其他",
};

export const SORT_OPTIONS: Array<{ id: MatchSort; label: string }> = [
  { id: "newest", label: "最新开局" },
  { id: "oldest", label: "最早开局" },
  { id: "rounds", label: "回合最多" },
  { id: "tokens", label: "Token 最多" },
];

const ROUTE_BY_KIND: Record<GameKind, string> = {
  werewolf: "table",
  rubric: "arena",
  coup: "coup",
};

const KIND_LABELS: Record<GameKind, string> = {
  werewolf: "九人局",
  rubric: "评分局",
  coup: "政变",
};

/** Where an event stream can be replayed. A third kind must add a line here. */
export function matchHref(match: { id: string; kind: GameKind }): string {
  return `/${ROUTE_BY_KIND[match.kind]}/${match.id}`;
}

export function kindLabel(kind: GameKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * A crash checkpoint is the only thing that separates "可以继续" from "已中断":
 * `interrupted` alone says the process died, `resumable` says it can be picked up.
 */
export function matchStatus(match: Pick<CatalogMatch, "status" | "resumable">): MatchStatusMeta {
  switch (match.status) {
    case "running":
      return { key: "live", label: STATUS_LABELS.live, tone: "jade" };
    case "interrupted":
      return match.resumable
        ? { key: "resumable", label: STATUS_LABELS.resumable, tone: "amber" }
        : { key: "interrupted", label: STATUS_LABELS.interrupted, tone: "blood" };
    case "failed":
      return { key: "failed", label: STATUS_LABELS.failed, tone: "blood" };
    case "aborted":
      return { key: "aborted", label: STATUS_LABELS.aborted, tone: "dim" };
    case "finished":
      return { key: "finished", label: STATUS_LABELS.finished, tone: "dim" };
    default:
      return { key: "unknown", label: match.status || "未知", tone: "dim" };
  }
}

const END_REASON_LABELS: Record<string, string> = {
  wolves_out: "狼人全灭",
  gods_wiped: "神职全灭",
  villagers_wiped: "村民全灭",
  max_days: "天数用尽",
  budget_exceeded: "预算耗尽",
  forfeit_limit: "弃权判负",
  judge_failed: "裁判失败",
  rubric_total: "总分决出",
  sudden_death: "加时决出",
  recovered_done: "续跑完成",
  manual: "手动结束",
};

/** Terminal reasons are stored as engine tokens; the UI says what they mean. */
export function endReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  if (reason.startsWith("aborted:")) {
    const inner = reason.slice("aborted:".length);
    if (!inner || inner === "manual") return "手动中止";
    return `中止 · ${END_REASON_LABELS[inner] ?? inner}`;
  }
  return END_REASON_LABELS[reason] ?? reason;
}

/** One-line result for dense rows; team scores are rendered separately. */
export function outcomeLabel(
  match: Pick<CatalogMatch, "kind" | "status" | "winnerTeamName" | "resumable">,
): string {
  if (match.winnerTeamName) return `${match.winnerTeamName}胜`;
  const status = matchStatus(match);
  if (status.key === "finished") return "无胜者";
  return status.label;
}

export function statusCounts(matches: readonly CatalogMatch[]): Record<MatchStatusKey, number> {
  const counts = Object.fromEntries(STATUS_ORDER.map((key) => [key, 0])) as Record<
    MatchStatusKey,
    number
  >;
  for (const match of matches) counts[matchStatus(match).key] += 1;
  return counts;
}

export function kindCounts(matches: readonly CatalogMatch[]): Record<GameKind, number> {
  const counts: Record<GameKind, number> = { werewolf: 0, rubric: 0, coup: 0 };
  for (const match of matches) counts[match.kind] += 1;
  return counts;
}

export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function clockLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function shortDateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Local calendar day; never UTC, so "今天" matches the wall clock on the desk. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function dayLabel(ts: number, now: number): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "昨天";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const day = sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return `${day} · ${WEEKDAYS[d.getDay()]}`;
}

export function formatCount(value: number): string {
  const digits = String(Math.max(0, Math.round(value)));
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Everything a search box may match: names, ids, seeds, teams, labels and dates. */
export function searchText(match: CatalogMatch): string {
  const status = matchStatus(match);
  const d = new Date(match.createdAt);
  return [
    match.id,
    match.rulesetName,
    match.seed,
    match.format,
    kindLabel(match.kind),
    status.label,
    match.status,
    match.winnerTeamName ?? "",
    match.endReason ?? "",
    endReasonLabel(match.endReason) ?? "",
    ...match.teams.map((team) => team.name),
    dayKey(match.createdAt),
    `${d.getMonth() + 1}/${d.getDate()}`,
    clockLabel(match.createdAt),
  ]
    .join(" ")
    .toLowerCase();
}

export function filterMatches<T extends CatalogMatch>(
  matches: readonly T[],
  options: { query?: string; kind?: KindFilter; status?: StatusFilter } = {},
): T[] {
  const tokens = (options.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kind = options.kind ?? "all";
  const status = options.status ?? "all";
  return matches.filter((match) => {
    if (kind !== "all" && match.kind !== kind) return false;
    if (status !== "all" && matchStatus(match).key !== status) return false;
    if (tokens.length === 0) return true;
    const haystack = searchText(match);
    return tokens.every((token) => haystack.includes(token));
  });
}

export function sortMatches<T extends CatalogMatch>(matches: readonly T[], sort: MatchSort): T[] {
  const list = [...matches];
  switch (sort) {
    case "oldest":
      list.sort((a, b) => a.createdAt - b.createdAt);
      break;
    case "rounds":
      list.sort((a, b) => b.rounds - a.rounds || b.createdAt - a.createdAt);
      break;
    case "tokens":
      list.sort((a, b) => b.tokensUsed - a.tokensUsed || b.createdAt - a.createdAt);
      break;
    default:
      list.sort((a, b) => b.createdAt - a.createdAt);
  }
  return list;
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Groups in the order the list already walks, so the active sort stays visible. */
export function groupByDay<T extends CatalogMatch>(matches: readonly T[], now: number): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();
  for (const match of matches) {
    const key = dayKey(match.createdAt);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: dayLabel(match.createdAt, now), items: [] };
      groups.set(key, group);
    }
    group.items.push(match);
  }
  return [...groups.values()];
}
