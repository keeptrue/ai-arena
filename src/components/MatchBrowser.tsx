"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  SORT_OPTIONS,
  STATUS_LABELS,
  STATUS_ORDER,
  clockLabel,
  cacheHitPercent,
  endReasonLabel,
  filterMatches,
  formatCount,
  groupByDay,
  kindCounts,
  kindLabel,
  matchHref,
  matchStatus,
  outcomeLabel,
  shortDateLabel,
  sortMatches,
  statusCounts,
  type CatalogMatch,
  type KindFilter,
  type MatchSort,
  type MatchStatusMeta,
  type StatusFilter,
  type StatusTone,
} from "@/lib/match-catalog";

/** Shared by the column header and every row so the columns actually line up. */
const ROW_GRID =
  "lg:grid-cols-[minmax(0,1fr)_6.5rem_9rem_3.5rem_5.5rem_9rem]";

const TONE_CLASS: Record<StatusTone, string> = {
  jade: "border-jade/35 bg-jade/10 text-jade",
  amber: "border-amber/40 bg-amber/10 text-amber",
  blood: "border-blood/35 bg-blood/10 text-blood",
  dim: "border-line bg-ink-2/60 text-fg-dim",
};

const KIND_FILTERS: KindFilter[] = ["all", "werewolf", "rubric"];

/**
 * The library body. Everything is client-side filtering over a server-rendered
 * snapshot, so typing never round-trips; `now` is fixed by the page for stable
 * day buckets between server HTML and hydration.
 */
export function MatchBrowser({ matches, now }: { matches: CatalogMatch[]; now: number }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<MatchSort>("newest");

  // Status counts ignore the status chip on purpose: chips must not collapse to
  // zero the moment one of them is picked.
  const scoped = useMemo(() => filterMatches(matches, { query, kind }), [matches, query, kind]);
  const counts = useMemo(() => statusCounts(scoped), [scoped]);
  const kinds = useMemo(() => kindCounts(filterMatches(matches, { query })), [matches, query]);

  const visible = useMemo(() => {
    const byStatus = status === "all" ? scoped : scoped.filter((m) => matchStatus(m).key === status);
    return sortMatches(byStatus, sort);
  }, [scoped, status, sort]);

  const chronological = sort === "newest" || sort === "oldest";
  const sections = useMemo(() => {
    if (!chronological) {
      return visible.length > 0 ? [{ key: "flat", label: "", items: visible }] : [];
    }
    return groupByDay(visible, now).map((group) => ({
      key: group.key,
      label: group.label,
      items: group.items,
    }));
  }, [chronological, visible, now]);

  const narrowed = query.trim() !== "" || kind !== "all" || status !== "all";
  const resumable = useMemo(
    () => matches.filter((m) => matchStatus(m).key === "resumable" && (kind === "all" || m.kind === kind)),
    [matches, kind],
  );

  const statusChips: Array<{ key: StatusFilter; label: string; count: number }> = [
    { key: "all", label: "全部", count: scoped.length },
    ...STATUS_ORDER.filter((key) => counts[key] > 0 || key === status).map((key) => ({
      key,
      label: STATUS_LABELS[key],
      count: counts[key],
    })),
  ];

  function reset() {
    setQuery("");
    setKind("all");
    setStatus("all");
    setSort("newest");
  }

  return (
    <div>
      {resumable.length > 0 && status === "all" && !query.trim() && (
        <section
          aria-label="可继续的对局"
          className="mb-5 rounded-xl border border-amber/30 bg-amber/[0.05] px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-amber">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber" />
            <span>{resumable.length} 局停在检查点上，可以接着跑</span>
            <span className="text-[11px] text-amber/70">点进去后按页面上的「继续对局」</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {resumable.map((match) => (
              <Link
                key={match.id}
                href={matchHref(match)}
                className="flex items-center gap-2 rounded-lg border border-amber/25 bg-ink-1/60 px-2.5 py-1.5 text-[11px] text-fg-dim transition hover:border-amber/50 hover:text-fg"
              >
                <span className="max-w-[12rem] truncate">{match.rulesetName}</span>
                <span className="mono text-[10px] text-fg-faint">
                  {shortDateLabel(match.createdAt)} {clockLabel(match.createdAt)}
                </span>
                <span className="text-amber">继续 →</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="-mx-6 mb-5 border-y border-line bg-ink-0/90 px-6 py-3 backdrop-blur-md lg:sticky lg:top-[57px] lg:z-30">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[15rem] flex-1">
            <span
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-faint"
            >
              ⌕
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索所有对局"
              placeholder="搜索：规则 / 种子 / 对局 id / 胜方 / 日期"
              className="w-full rounded-lg border border-line bg-ink-1 py-2 pl-9 pr-3 text-[13px] text-fg outline-none transition placeholder:text-fg-faint focus:border-jade/40"
            />
          </label>

          <div
            className="flex items-center gap-0.5 rounded-lg border border-line bg-ink-1 p-0.5"
            role="group"
            aria-label="对局类型"
          >
            {KIND_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                aria-pressed={kind === option}
                className={`rounded px-2.5 py-1 text-[11px] transition ${
                  kind === option ? "bg-ink-3 text-fg" : "text-fg-faint hover:text-fg-dim"
                }`}
              >
                {option === "all" ? "全部" : kindLabel(option)}
                <span className="mono ml-1 text-[10px] opacity-60">
                  {option === "all" ? kinds.werewolf + kinds.rubric : kinds[option]}
                </span>
              </button>
            ))}
          </div>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as MatchSort)}
            aria-label="排序"
            className="rounded-lg border border-line bg-ink-1 px-2 py-2 text-[12px] text-fg-dim outline-none"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {statusChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setStatus(chip.key)}
              aria-pressed={status === chip.key}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                status === chip.key
                  ? "border-jade/50 bg-jade/10 text-jade"
                  : "border-line bg-ink-1 text-fg-dim hover:border-line-strong hover:text-fg"
              }`}
            >
              {chip.label}
              <span className="mono ml-1 text-[10px] opacity-60">{chip.count}</span>
            </button>
          ))}
          <span className="ml-auto flex items-center gap-2 text-[11px] text-fg-faint">
            <span className="mono">
              {visible.length} / {matches.length} 局
            </span>
            {narrowed && (
              <button
                type="button"
                onClick={reset}
                className="rounded border border-line px-2 py-0.5 text-[10px] text-fg-dim transition hover:border-jade/40 hover:text-jade"
              >
                清空筛选
              </button>
            )}
          </span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="panel px-5 py-16 text-center">
          <p className="text-[13px] text-fg-dim">
            {matches.length === 0 ? "还没有对局记录。" : "没有匹配的对局。"}
          </p>
          <p className="mt-1 text-[12px] text-fg-faint">
            {matches.length === 0 ? "去开局页挑一套规则开一桌。" : "换个关键词，或者清空筛选条件。"}
          </p>
          {matches.length === 0 ? (
            <Link
              href="/"
              className="mt-4 inline-block rounded-md border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade"
            >
              去开局 →
            </Link>
          ) : (
            <button
              type="button"
              onClick={reset}
              className="mt-4 rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-jade/40 hover:text-jade"
            >
              清空筛选
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div
            className={`hidden gap-3 px-4 pb-1 text-[10px] tracking-[0.16em] text-fg-faint lg:grid ${ROW_GRID}`}
          >
            <span>对局</span>
            <span>状态</span>
            <span>结果</span>
            <span className="text-right">回合</span>
            <span className="text-right">TOKENS</span>
            <span className="text-right">时间 / 操作</span>
          </div>

          {sections.map((section) => (
            <section key={section.key}>
              {section.label && (
                <div className="mb-2 flex items-baseline gap-2">
                  <h2 className="text-[12px] font-medium text-fg-dim">{section.label}</h2>
                  <span className="mono text-[10px] text-fg-faint">{section.items.length} 局</span>
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </div>
              )}
              <div className="panel divide-y divide-line/60 overflow-hidden">
                {section.items.map((match) => (
                  <MatchRow key={match.id} match={match} showDate={!chronological} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function MatchRow({ match, showDate }: { match: CatalogMatch; showDate: boolean }) {
  const status = matchStatus(match);
  const reason = endReasonLabel(match.endReason);
  const when = showDate
    ? `${shortDateLabel(match.createdAt)} ${clockLabel(match.createdAt)}`
    : clockLabel(match.createdAt);

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3 transition hover:bg-ink-2/50 lg:items-center ${ROW_GRID}`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded border border-line px-1.5 py-[1px] text-[10px] text-fg-faint">
            {kindLabel(match.kind)}
          </span>
          <Link
            href={matchHref(match)}
            className="truncate text-[13px] font-medium text-fg transition hover:text-jade"
          >
            {match.rulesetName}
          </Link>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-fg-faint">
          <span className="mono hidden sm:inline" title={match.seed}>
            {match.seed}
          </span>
          <span aria-hidden className="hidden sm:inline">
            ·
          </span>
          <span className="mono hidden sm:inline">{match.format}</span>
          <span aria-hidden className="hidden sm:inline lg:hidden">
            ·
          </span>
          <span className="lg:hidden">
            <StatusPill status={status} />
          </span>
          <span className="lg:hidden">
            <Outcome match={match} />
          </span>
        </div>
      </div>

      <div className="hidden lg:block">
        <StatusPill status={status} />
      </div>
      <div className="hidden min-w-0 lg:block" title={reason ?? undefined}>
        <Outcome match={match} />
      </div>
      <div
        className="mono hidden text-right text-[11px] text-fg-dim lg:block"
        title="已经结束的回合数"
      >
        {match.rounds}
      </div>
      <div
        className="mono hidden text-right text-[11px] text-fg-faint lg:block"
        title={
          cacheHitPercent(match) !== null
            ? `其中 ${formatCount(match.cachedTokens ?? 0)} 来自前缀缓存`
            : "没有命中前缀缓存"
        }
      >
        {formatCount(match.tokensUsed)}
        {cacheHitPercent(match) !== null ? ` ⚡${cacheHitPercent(match)}%` : ""}
      </div>

      <div className="flex items-center justify-end gap-2 lg:gap-3">
        <div className="text-right">
          <div className="mono text-[11px] text-fg-dim">{when}</div>
          <div className="mono text-[10px] text-fg-faint lg:hidden">{match.rounds} 回合</div>
        </div>
        <Link
          href={matchHref(match)}
          className="shrink-0 rounded border border-line px-2 py-1 text-[10px] text-fg-dim transition hover:border-jade/40 hover:text-jade"
        >
          打开
        </Link>
        {match.kind === "werewolf" && (
          <a
            href={`/api/matches/${match.id}/export`}
            download
            title="下载可离线回放的单文件"
            className="hidden shrink-0 rounded border border-line px-2 py-1 text-[10px] text-fg-faint transition hover:border-line-strong hover:text-fg-dim sm:inline-block"
          >
            HTML
          </a>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: MatchStatusMeta }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${TONE_CLASS[status.tone]}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full bg-current ${status.key === "live" ? "live-dot" : ""}`}
      />
      {status.label}
    </span>
  );
}

function Outcome({ match }: { match: CatalogMatch }) {
  if (match.kind === "werewolf") {
    if (!match.winnerTeamName && match.status !== "finished") {
      // An unfinished match has no result yet; the status column already says why.
      return <span className="text-[11px] text-fg-faint">—</span>;
    }
    return (
      <span className={`text-[11px] ${match.winnerTeamName ? "text-fg" : "text-fg-faint"}`}>
        {outcomeLabel(match)}
      </span>
    );
  }
  if (match.teams.length === 0) {
    return <span className="text-[11px] text-fg-faint">{matchStatus(match).label}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {match.teams.map((team) => (
        <span
          key={team.id}
          className="inline-flex items-center gap-1 text-[11px]"
          style={{ color: team.color }}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: team.color }} />
          <span className="max-w-[5.5rem] truncate">{team.name}</span>
          <span className="mono text-[10px] opacity-80">{team.total.toFixed(2)}</span>
        </span>
      ))}
    </span>
  );
}
