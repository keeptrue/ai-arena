"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArenaEvent, BoardSpec, ModelSnapshot, Settlement } from "@/engine/types";
import { boardSeries, foldBoard } from "@/lib/board";
import { clearPin, pinPhaseLabel, publishPin, type MatchPin } from "@/lib/pin";
import { ArenaScoreboard } from "./arena-board";
import { EffortChip, LiveStream } from "./arena-blocks";
import {
  DmPanel,
  RoundCard,
  TeamColumn,
  type RoundView,
  type SlotDef,
  type TeamIndex,
  type TeamView,
} from "./arena-parts";

interface Meta {
  name: string;
  tagline: string;
  rounds: number;
  tieThreshold: number;
  seed: string;
  slots: SlotDef[];
  dimensions: Array<{ key: string; label: string; weight: number }>;
  /** Optional live scoreboard declared by the rules; null/absent = draw nothing. */
  board?: BoardSpec | null;
}

interface JudgeInfo {
  display: string;
  provider: string;
  modelId: string;
  reasoning?: string | null;
  budget?: number | null;
}

interface ReconciledRound {
  settlement: Settlement;
  scores: NonNullable<RoundView["verdict"]>["scores"];
  teamScores: Record<string, number>;
}

interface ViewState {
  meta: Meta | null;
  teams: TeamView[];
  /** Frozen model snapshots from the match row, keyed by participant id. */
  roster: Record<string, ModelSnapshot>;
  judge: JudgeInfo | null;
  round: number;
  phase: "connecting" | "collecting" | "judging" | "paused" | "done";
  history: RoundView[];
  judgeChunks: string[];
  pendingVerdict: RoundView["verdict"];
  finish: {
    winnerTeamId: string | null;
    winnerName: string | null;
    reason: string;
    rounds: number;
  } | null;
  dm: Array<{ kind: string; text?: string }>;
  anomalies: Array<{ code: string; seat?: number; message?: string }>;
  /** round → corrected ledger + scores appended by `scripts/repair-board.ts`. */
  reconciled: Record<number, ReconciledRound>;
  notFound: boolean;
}

/** Stable identities for the "nothing here" cases: props must not churn per render. */
const EMPTY_SLOTS: SlotDef[] = [];
const EMPTY_DIMENSIONS: Array<{ key: string; label: string; weight: number }> = [];

const EMPTY: ViewState = {
  meta: null,
  teams: [],
  roster: {},
  judge: null,
  round: 0,
  phase: "connecting",
  history: [],
  judgeChunks: [],
  pendingVerdict: null,
  finish: null,
  dm: [],
  anomalies: [],
  reconciled: {},
  notFound: false,
};

function mapMember(m: any, roster: Record<string, ModelSnapshot>): TeamView["members"][number] {
  const snap = roster[m.id as string];
  return {
    id: m.id,
    seat: m.seat,
    display: m.display ?? snap?.display ?? `#${m.seat}`,
    provider: m.provider ?? snap?.providerName ?? "",
    modelId: m.modelId ?? snap?.modelId ?? "",
    kind: snap?.kind ?? null,
    temperature: snap?.temperature ?? null,
    thinkingBudget: snap?.thinkingBudget ?? null,
    callTimeoutMs: snap?.callTimeoutMs ?? null,
    reasoning: snap?.reasoningEffort ?? m.reasoning ?? null,
    status: "idle",
    thinking: "",
    thinkingDone: false,
    content: null,
    usage: null,
    latencyMs: null,
    forfeitReason: null,
  };
}

function withMember(
  state: ViewState,
  participantId: string,
  patch: (m: TeamView["members"][number]) => TeamView["members"][number],
): ViewState {
  let touched = false;
  const teams = state.teams.map((t) => {
    if (!t.members.some((m) => m.id === participantId)) return t;
    touched = true;
    return { ...t, members: t.members.map((m) => (m.id === participantId ? patch(m) : m)) };
  });
  // Untouched teams (and their members) keep their identity, so memoised cards only
  // repaint the seat that actually emitted. Without this every delta rebuilt the roster.
  return touched ? { ...state, teams } : state;
}

function applyEvent(state: ViewState, event: ArenaEvent): ViewState {
  const p = event.payload as any;
  switch (event.type) {
    case "match.created": {
      return {
        ...state,
        phase: "collecting",
        meta: {
          name: p.name,
          tagline: p.tagline ?? "",
          rounds: p.rounds,
          tieThreshold: p.tieThreshold ?? 0.5,
          seed: p.seed,
          slots: p.slots ?? [],
          dimensions: p.dimensions ?? [],
          board: (p.board as BoardSpec | null) ?? null,
        },
        teams: (p.teams as any[]).map((t) => ({
          id: t.id,
          idx: t.idx,
          name: t.name,
          color: t.color,
          members: (t.members as any[]).map((m) => mapMember(m, state.roster)),
          total: 0,
          roundScore: 0,
        })),
      };
    }

    case "round.opened": {
      return {
        ...state,
        round: p.round,
        phase: "collecting",
        judgeChunks: [],
        teams: state.teams.map((t) => ({
          ...t,
          roundScore: 0,
          members: t.members.map((m) => ({
            ...m,
            status: "idle" as const,
            thinking: "",
            thinkingDone: false,
            content: null,
            usage: null,
            latencyMs: null,
            forfeitReason: null,
          })),
        })),
      };
    }

    case "seat.thinking.delta": {
      const id = p.participantId as string;
      return withMember(state, id, (m) => ({
        ...m,
        status: m.status === "ready" || m.status === "forfeit" ? m.status : "thinking",
        // Append, never rebuild: the array-spread version allocated a new list per
        // delta and made every consumer re-join the whole text on every render.
        thinking: m.thinking + (typeof p.delta === "string" ? p.delta : ""),
      }));
    }

    case "seat.submitted": {
      const id = p.participantId as string;
      return withMember(state, id, (m) => ({
        ...m,
        status: "ready",
        content: (p.content ?? {}) as Record<string, unknown>,
        thinking: typeof p.thinking === "string" && p.thinking ? p.thinking : m.thinking,
        thinkingDone: true,
        usage: (p.usage as { promptTokens: number; completionTokens: number }) ?? null,
        latencyMs: typeof p.latencyMs === "number" ? p.latencyMs : null,
      }));
    }

    case "seat.forfeit": {
      const id = p.participantId as string;
      return withMember(state, id, (m) => ({
        ...m,
        status: "forfeit",
        thinkingDone: true,
        forfeitReason: typeof p.reason === "string" ? p.reason : null,
      }));
    }

    // A seat was handed its turn back: it is thinking again, and the strike is gone.
    case "seat.recalled": {
      const id = p.participantId as string;
      if (!id) return state;
      return withMember(state, id, (m) => ({
        ...m,
        status: "thinking",
        thinking: "",
        thinkingDone: false,
        forfeitReason: null,
        content: null,
      }));
    }

    case "round.collected": {
      return { ...state, phase: "judging" };
    }

    case "judge.thinking.delta": {
      return { ...state, judgeChunks: [...state.judgeChunks, p.delta as string] };
    }

    case "state.updated": {
      if (p.paused === true) return { ...state, phase: "paused" };
      return state;
    }

    case "dm.intervened": {
      const paused = p.kind === "pause" ? true : p.kind === "resume" ? false : null;
      return {
        ...state,
        dm: [...state.dm, { kind: p.kind, text: p.text }],
        phase:
          paused === true
            ? "paused"
            : paused === false
              ? state.phase === "paused"
                ? "collecting"
                : state.phase
              : state.phase,
      };
    }

    case "anomaly": {
      return {
        ...state,
        anomalies: [...state.anomalies, { code: p.code, seat: event.seat, message: p.message }],
      };
    }

    case "round.verdict": {
      // Stash it; round.closed assembles the record with the submissions.
      return {
        ...state,
        pendingVerdict: {
          publicSummary: p.publicSummary ?? "",
          verdict: p.verdict ?? "",
          scores: p.scores ?? [],
          judge: p.judge ?? "",
          marks: (p.marks as number[] | undefined) ?? [],
          suddenWinnerTeamId: p.suddenWinnerTeamId ?? null,
          blindMap: (p.blindMap as Record<string, string> | undefined) ?? undefined,
        },
      };
    }

    case "board.reconciled": {
      // Appended by the repair script: the ledger outranks what the judge wrote,
      // and totals are re-derived from these corrected round scores.
      const round = Number(p.round);
      const settlement = p.settlement as Settlement | undefined;
      if (!Number.isFinite(round) || !settlement) return state;
      return {
        ...state,
        reconciled: {
          ...state.reconciled,
          [round]: {
            settlement,
            scores: (p.scores ?? []) as ReconciledRound["scores"],
            teamScores: (p.teamScores ?? {}) as Record<string, number>,
          },
        },
      };
    }

    case "round.closed": {
      const verdict = state.pendingVerdict;
      const record: RoundView = {
        round: p.round,
        sudden: !!p.sudden,
        submissions: state.teams.flatMap((t) =>
          t.members.map((m) => ({
            participantId: m.id,
            seat: m.seat,
            teamId: t.id,
            display: m.display,
            modelId: m.modelId,
            reasoning: m.reasoning ?? null,
            usage: m.usage ?? null,
            latencyMs: m.latencyMs ?? null,
            status: m.status === "forfeit" ? "forfeit" : "ready",
            content: m.content ?? {},
            thinking: m.thinking,
          })),
        ),
        verdict,
        settlement: p.settlement ?? null,
        judgeThinking: state.judgeChunks.join(""),
        teamScores: (p.teamScores ?? {}) as Record<string, number>,
      };
      const totals = (p.totals ?? {}) as Record<string, number>;
      return {
        ...state,
        pendingVerdict: null,
        judgeChunks: [],
        history: [...state.history, record],
        teams: state.teams.map((t) => ({
          ...t,
          total: totals[t.id] ?? t.total,
          roundScore: record.teamScores[t.id] ?? 0,
        })),
      };
    }

    case "match.finished": {
      const standings = (p.standings ?? []) as Array<{ id: string; total: number }>;
      const byId = new Map(standings.map((s) => [s.id, s.total]));
      return {
        ...state,
        phase: "done",
        finish: {
          winnerTeamId: p.winnerTeamId ?? null,
          winnerName: p.winnerTeamName ?? null,
          reason: p.reason,
          rounds: p.rounds,
        },
        teams: state.teams.map((t) => ({ ...t, total: byId.get(t.id) ?? t.total })),
      };
    }

    default:
      return state;
  }
}

export function ArenaView({ matchId }: { matchId: string }) {
  const [view, setView] = useState<ViewState>(EMPTY);
  const lastSeq = useRef(0);
  const pending = useRef<ArenaEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showDm, setShowDm] = useState(true);
  const baseTitle = useRef<string | null>(null);
  // Is anything driving this match, and is there a checkpoint to rewind to?
  const [link, setLink] = useState<{ live: boolean; resumable: boolean }>({ live: true, resumable: false });
  // Why a recall was refused (the engine, not the button, decides when it is legal).
  const [recallNote, setRecallNote] = useState<string | null>(null);
  // Bumping this re-runs boot: a recovery has to re-read the log and reopen the stream.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const flush = () => {
      timer.current = null;
      const batch = pending.current;
      pending.current = [];
      const fresh = batch.filter((e) => e.seq > lastSeq.current);
      if (fresh.length === 0) return;
      lastSeq.current = fresh[fresh.length - 1].seq;
      setView((v) => fresh.reduce(applyEvent, v));
    };

    const enqueue = (events: ArenaEvent[]) => {
      pending.current.push(...events);
      if (timer.current == null) timer.current = setTimeout(flush, 16);
    };

    async function boot() {
      try {
        const res = await fetch(`/api/matches/${matchId}`, { cache: "no-store" });
        if (res.status === 404) {
          if (!cancelled) setView({ ...EMPTY, notFound: true });
          return;
        }
        const data = (await res.json()) as {
          match: { status: string };
          roster?: { participants: Array<{ id: string; model: ModelSnapshot }> };
          judge?: ModelSnapshot | null;
          events: ArenaEvent[];
          live?: boolean;
          resumable?: boolean;
        };
        if (cancelled) return;
        const roster: Record<string, ModelSnapshot> = {};
        for (const p of data.roster?.participants ?? []) roster[p.id] = p.model;
        const judge: JudgeInfo | null = data.judge
          ? {
              display: data.judge.display,
              provider: data.judge.providerName,
              modelId: data.judge.modelId,
              reasoning: data.judge.reasoningEffort ?? null,
              budget: data.judge.thinkingBudget ?? null,
            }
          : null;
        setView((v) => ({ ...v, roster, judge }));
        enqueue(data.events);
        setLink({ live: data.live !== false, resumable: data.resumable === true });
        if (["finished", "failed", "aborted"].includes(data.match.status)) return;

        source = new EventSource(`/api/matches/${matchId}/stream?after=${lastSeq.current}`);
        // A restarted server reconnects the stream silently; re-read the truth so the
        // page stops claiming a dead match is still collecting.
        source.onopen = () => void refreshLink();
        source.onmessage = (ev) => {
          try {
            enqueue([JSON.parse(ev.data) as ArenaEvent]);
          } catch {
            /* ignore malformed frame */
          }
        };
      } catch {
        if (!cancelled) setView((v) => ({ ...v, phase: "connecting" }));
      }
    }

    void boot();
    return () => {
      cancelled = true;
      if (timer.current != null) clearTimeout(timer.current);
      source?.close();
    };
  }, [matchId, reload]);

  async function recover() {
    try {
      const res = await fetch(`/api/matches/${matchId}/recover`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) return;
      setReload((n) => n + 1);
    } catch {
      /* the DM panel keeps its own toast */
    }
  }

  /**
   * Hand a seat its turn back after a cut that produced nothing. The engine, not
   * the button, decides legality: a judged round comes back refused with a reason.
   */
  const recall = useCallback(
    async (participantId: string) => {
      setRecallNote(null);
      try {
        const res = await fetch(`/api/matches/${matchId}/intervene`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "recall", participantId }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string; code?: string };
        if (!res.ok || !data.ok) throw new Error(data.error ?? "补叫失败");
      } catch (err) {
        setRecallNote(err instanceof Error ? err.message : String(err));
      }
    },
    [matchId],
  );

  /** Cheap status read: live / resumable, one event at most. */
  async function refreshLink() {
    try {
      const res = await fetch(`/api/matches/${matchId}?after=${lastSeq.current}&limit=1`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { live?: boolean; resumable?: boolean };
      setLink({ live: data.live !== false, resumable: data.resumable === true });
    } catch {
      /* keep the last known state */
    }
  }

  const teams = view.teams;
  // `?? []` allocates a fresh array every render, which silently defeats memo on
  // every child that receives it. Module-level empties keep the props stable.
  const slots = view.meta?.slots ?? EMPTY_SLOTS;
  const totalSeats = teams.reduce((n, t) => n + t.members.length, 0);
  const settled = teams.reduce(
    (n, t) => n + t.members.filter((m) => m.status === "ready" || m.status === "forfeit").length,
    0,
  );
  const winner = teams.find((t) => t.id === view.finish?.winnerTeamId);
  // Dead, but not settled: nobody is driving this match any more.
  const stalled = !link.live && view.phase !== "done" && view.phase !== "connecting";

  const cols = useMemo(() => Math.max(1, teams.length), [teams.length]);

  const board = view.meta?.board ?? null;
  const teamKey = teams.map((t) => t.id).join(",");
  const teamIds = useMemo(() => (teamKey ? teamKey.split(",") : []), [teamKey]);

  // A repaired round replaces the judge's numbers with the ledger's. Resolving it once
  // keeps the board, the trend, the cards and the totals on the same history.
  const displayHistory = useMemo(() => {
    if (Object.keys(view.reconciled).length === 0) return view.history;
    return view.history.map((r) => {
      const rec = view.reconciled[r.round];
      if (!rec) return r;
      return {
        ...r,
        settlement: rec.settlement,
        teamScores: rec.teamScores,
        verdict: r.verdict ? { ...r.verdict, scores: rec.scores } : r.verdict,
      };
    });
  }, [view.history, view.reconciled]);

  const boardSnapshot = useMemo(
    () => foldBoard(board ?? undefined, teamIds, displayHistory),
    [board, teamIds, displayHistory],
  );
  const boardTrend = useMemo(
    () => boardSeries(board ?? undefined, teamIds, displayHistory),
    [board, teamIds, displayHistory],
  );

  // Totals come from the runtime, plus whatever a repaired round changed.
  const adjustedTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of teams) {
      let total = t.total;
      for (const r of view.history) {
        const rec = view.reconciled[r.round];
        if (!rec) continue;
        total += (rec.teamScores[t.id] ?? 0) - (r.teamScores[t.id] ?? 0);
      }
      out[t.id] = Number(total.toFixed(3));
    }
    return out;
  }, [teams, view.history, view.reconciled]);

  const teamsView = useMemo(
    () => teams.map((t) => ({ ...t, total: adjustedTotals[t.id] ?? t.total })),
    [teams, adjustedTotals],
  );

  // Team names and colours are frozen at match creation, so this table is stable for
  // the whole match: history cards can skip re-rendering while a seat streams.
  const teamIndex = useMemo(() => {
    const out: TeamIndex = {};
    for (const t of teams) out[t.id] = { name: t.name, color: t.color };
    return out;
  }, [teamKey]);
  const dimensions = view.meta?.dimensions ?? EMPTY_DIMENSIONS;

  // The tab bar is the other place a long match gets lost: title carries phase + round.
  useEffect(() => {
    if (!view.meta) return;
    if (baseTitle.current === null) baseTitle.current = document.title;
    document.title = `${pinPhaseLabel(view.phase)} ${view.round}/${view.meta.rounds} · ${view.meta.name} · 斗场`;
  }, [view.meta, view.round, view.phase]);

  useEffect(
    () => () => {
      if (baseTitle.current !== null) document.title = baseTitle.current;
    },
    [],
  );

  // Only the visible tab may claim the header chip: two live matches in two tabs must
  // not overwrite each other on every delta. The pin record itself is written rarely
  // (round / phase / seat changes), never per thinking chunk.
  const sighting = useMemo<MatchPin | null>(() => {
    if (!view.meta) return null;
    return {
      id: matchId,
      kind: "rubric",
      name: view.meta.name,
      phase: view.phase,
      round: view.round,
      rounds: view.meta.rounds,
      settled,
      seats: totalSeats,
      ts: Date.now(),
    };
  }, [matchId, view.meta, view.phase, view.round, settled, totalSeats]);

  useEffect(() => {
    if (!sighting) return;
    const publish = () => {
      if (document.visibilityState === "visible") publishPin(sighting);
    };
    publish();
    document.addEventListener("visibilitychange", publish);
    return () => document.removeEventListener("visibilitychange", publish);
  }, [sighting]);

  // A deleted match must not leave a chip pointing at nothing.
  useEffect(() => {
    if (view.notFound) clearPin(matchId);
  }, [view.notFound, matchId]);

  if (view.notFound) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-24 text-center">
        <p className="text-[15px] text-fg-dim">这一局不存在，或者已经被清掉了。</p>
        <Link href="/" className="mt-4 inline-block text-[13px] text-jade underline underline-offset-4">
          回开局页
        </Link>
      </main>
    );
  }

  return (
    <main
      className="mx-auto max-w-[1500px] px-6 pb-24"
      data-status={view.phase}
      data-round={view.round}
      data-settled={`${settled}/${totalSeats}`}
    >
      <header className="flex flex-wrap items-end justify-between gap-4 py-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-[20px] font-semibold tracking-tight">{view.meta?.name ?? "对局"}</h1>
            <StatusChip phase={view.phase} />
            {stalled && (
              <span className="rounded border border-amber/30 bg-amber/10 px-2 py-0.5 text-[10px] text-amber">
                已中断
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[13px] text-fg-dim">{view.meta?.tagline}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="label">裁判</span>
            {view.judge ? (
              <>
                <span className="truncate text-fg-dim">{view.judge.display}</span>
                <span className="shrink-0 rounded border border-line px-1.5 py-[1px] text-[10px] text-fg-faint">
                  {view.judge.provider}
                </span>
                <span className="mono truncate text-[11px] text-fg-faint">{view.judge.modelId}</span>
                <EffortChip effort={view.judge.reasoning} budget={view.judge.budget} />
              </>
            ) : (
              <span className="text-fg-faint">未记录</span>
            )}
          </div>
        </div>

        <div className="flex items-end gap-5">
          <Stat label="回合" value={`${view.round}/${view.meta?.rounds ?? "?"}`} />
          <Stat label="就位" value={`${settled}/${totalSeats}`} />
          <Stat label="种子" value={view.meta?.seed ?? "—"} mono />
          <button
            onClick={() => setShowDm((v) => !v)}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg"
          >
            {showDm ? "收起 DM" : "展开 DM"}
          </button>
        </div>
      </header>

      {stalled && (
        <div className="panel mb-4 border-amber/30 px-3 py-2 text-[12px] text-amber">
          <p>
            第 {view.round} 轮停在「{pinPhaseLabel(view.phase)}」：进程重启后没人推进。
          </p>
          {link.resumable ? (
            <p className="mt-0.5">点 DM 面板的「从断点继续」，只会补叫还没交卷的座位。</p>
          ) : (
            <p className="mt-0.5 text-fg-faint">
              这一局没有断点（建于断点功能之前，或断点写入失败），只能当回放看。
            </p>
          )}
        </div>
      )}

      <div className="mb-4 h-[2px] w-full overflow-hidden rounded bg-ink-3">
        <div
          className="h-full rounded bg-jade/70 transition-[width] duration-500"
          style={{ width: `${totalSeats ? (settled / totalSeats) * 100 : 0}%` }}
        />
      </div>

      {recallNote && (
        <div className="panel mb-4 border-amber/30 px-3 py-2 text-[12px] text-amber">{recallNote}</div>
      )}

      {view.finish && (
        <div className="panel mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="label">终局</span>
          <span className="text-[15px] font-medium" style={{ color: winner?.color }}>
            {view.finish.winnerName ? `${view.finish.winnerName} 胜` : "平局"}
          </span>
          <span className="text-[13px] text-fg-dim">
            {reasonLabel(view.finish.reason)} · 共 {view.finish.rounds} 轮
          </span>
          <span className="mono ml-auto text-[11px] text-fg-faint">
            {[...teamsView]
              .sort((a, b) => b.total - a.total)
              .map((t) => `${t.name} ${t.total.toFixed(2)}`)
              .join("   ")}
          </span>
        </div>
      )}

      {board && teams.length > 0 && (
        <ArenaScoreboard
          board={board}
          teams={teams.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
          values={boardSnapshot.values}
          series={boardTrend.points}
          missing={boardTrend.missing}
          round={boardSnapshot.round}
          rounds={view.meta?.rounds ?? 0}
          stale={boardSnapshot.stale}
        />
      )}

      {teams.length === 0 ? (
        <div className="panel h-[320px] animate-pulse bg-ink-1/50" />
      ) : (
        <div
          className="grid gap-3 grid-cols-1 lg:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
          style={{ ["--cols" as string]: cols }}
        >
          {teamsView.map((t) => (
            <TeamColumn
              key={t.id}
              team={t}
              slots={slots}
              round={view.round}
              live={!stalled}
              onRecall={!stalled && view.phase === "collecting" ? recall : undefined}
            />
          ))}
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        <section className="min-w-0 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-medium">逐轮裁决</h2>
            <span className="mono text-[11px] text-fg-faint">{view.history.length} 轮已裁决</span>
          </div>

          {view.history.length === 0 && (
            <p className="panel px-4 py-8 text-center text-[13px] text-fg-faint">
              第一轮还在场上，等所有人交齐。
            </p>
          )}
          {[...displayHistory].reverse().map((r) => {
            const idx = displayHistory.findIndex((x) => x.round === r.round);
            const prev = idx > 0 ? displayHistory[idx - 1] : null;
            return (
              <RoundCard
                key={r.round}
                record={r}
                teamIndex={teamIndex}
                slots={slots}
                dimensions={dimensions}
                board={board}
                prevScores={prev?.verdict?.scores ?? null}
                repaired={Boolean(view.reconciled[r.round])}
              />
            );
          })}

          {view.judgeChunks.length > 0 && !view.finish && (
            <article className="panel px-4 py-3">
              <LiveStream chunks={view.judgeChunks} label="裁判推演" />
            </article>
          )}
        </section>

        {showDm && (
          <aside className="min-w-0 space-y-3 lg:sticky lg:top-20 lg:self-start">
            <DmPanel
              matchId={matchId}
              teams={teamsView}
              paused={view.phase === "paused"}
              disabled={view.phase === "done"}
              resumable={link.resumable}
              onRecover={() => void recover()}
            />

            {view.dm.length > 0 && (
              <div className="panel p-4">
                <div className="label mb-2">场外记录</div>
                <ul className="space-y-1 text-[12px] text-fg-dim">
                  {view.dm.map((d, i) => (
                    <li key={i}>
                      <span className="mono text-[10px] text-fg-faint">{d.kind}</span>
                      {d.text ? ` · ${d.text}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {view.anomalies.length > 0 && (
              <div className="panel border-amber/25 p-4">
                <div className="label mb-2 text-amber/80">异常</div>
                <ul className="space-y-1 text-[11px] text-amber/90">
                  {view.anomalies.map((a, i) => (
                    <li key={i} className="mono break-words">
                      {a.code}
                      {a.message ? ` — ${a.message}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="text-right">
      <div className="label">{label}</div>
      <div className={`mt-0.5 text-[12px] text-fg-dim ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

function StatusChip({ phase }: { phase: ViewState["phase"] }) {
  const map = {
    connecting: { label: "连接中", cls: "text-fg-faint border-line" },
    collecting: { label: "出招中", cls: "text-jade border-jade/30 bg-jade/10" },
    judging: { label: "裁决中", cls: "text-amber border-amber/30 bg-amber/10" },
    paused: { label: "已暂停", cls: "text-amber border-amber/30 bg-amber/10" },
    done: { label: "已终局", cls: "text-fg-dim border-line bg-ink-2" },
  } as const;
  const s = map[phase];
  return <span className={`rounded border px-2 py-0.5 text-[10px] ${s.cls}`}>{s.label}</span>;
}

function reasonLabel(reason: string) {
  const map: Record<string, string> = {
    rubric_total: "常规轮累计分",
    sudden_death: "加时定胜负",
    forfeit_limit: "对方连续弃权",
    judge_failed: "裁判调用失败，按已得分结算",
    budget_exceeded: "预算耗尽",
    mutual_destruction: "同归于尽",
  };
  return map[reason] ?? reason;
}
