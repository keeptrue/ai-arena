"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArenaEvent, BoardSpec, ModelSnapshot } from "@/engine/types";
import { foldBoard } from "@/lib/board";
import { BoardStrip } from "./arena-board";
import { EffortChip } from "./arena-blocks";
import {
  DmPanel,
  RoundCard,
  TeamColumn,
  type RoundView,
  type SlotDef,
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
  notFound: boolean;
}

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
    reasoning: snap?.reasoningEffort ?? m.reasoning ?? null,
    status: "idle",
    thinking: [],
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
  return {
    ...state,
    teams: state.teams.map((t) => ({
      ...t,
      members: t.members.map((m) => (m.id === participantId ? patch(m) : m)),
    })),
  };
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
            thinking: [],
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
        thinking: [...m.thinking, p.delta as string],
      }));
    }

    case "seat.submitted": {
      const id = p.participantId as string;
      return withMember(state, id, (m) => ({
        ...m,
        status: "ready",
        content: (p.content ?? {}) as Record<string, unknown>,
        thinking: p.thinking ? [p.thinking as string] : m.thinking,
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
            thinking: m.thinking.join(""),
          })),
        ),
        verdict,
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
        if (["finished", "failed", "aborted", "interrupted"].includes(data.match.status)) return;

        source = new EventSource(`/api/matches/${matchId}/stream?after=${lastSeq.current}`);
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
  }, [matchId]);

  const teams = view.teams;
  const slots = view.meta?.slots ?? [];
  const totalSeats = teams.reduce((n, t) => n + t.members.length, 0);
  const settled = teams.reduce(
    (n, t) => n + t.members.filter((m) => m.status === "ready" || m.status === "forfeit").length,
    0,
  );
  const winner = teams.find((t) => t.id === view.finish?.winnerTeamId);

  const cols = useMemo(() => Math.max(1, teams.length), [teams.length]);

  const board = view.meta?.board ?? null;
  const teamKey = teams.map((t) => t.id).join(",");
  const boardSnapshot = useMemo(
    () => foldBoard(board ?? undefined, teamKey ? teamKey.split(",") : [], view.history),
    [board, teamKey, view.history],
  );
  const boardMarks = view.history.length
    ? (view.history[view.history.length - 1].verdict?.marks ?? [])
    : [];

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

      <div className="mb-4 h-[2px] w-full overflow-hidden rounded bg-ink-3">
        <div
          className="h-full rounded bg-jade/70 transition-[width] duration-500"
          style={{ width: `${totalSeats ? (settled / totalSeats) * 100 : 0}%` }}
        />
      </div>

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
            {[...teams]
              .sort((a, b) => b.total - a.total)
              .map((t) => `${t.name} ${t.total.toFixed(2)}`)
              .join("   ")}
          </span>
        </div>
      )}

      {board && teams.length > 0 && (
        <BoardStrip
          board={board}
          teams={teams.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
          values={boardSnapshot.values}
          stale={boardSnapshot.stale}
          round={boardSnapshot.round}
          marks={boardMarks}
        />
      )}

      {teams.length === 0 ? (
        <div className="panel h-[320px] animate-pulse bg-ink-1/50" />
      ) : (
        <div
          className="grid gap-3 grid-cols-1 lg:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
          style={{ ["--cols" as string]: cols }}
        >
          {teams.map((t) => (
            <TeamColumn key={t.id} team={t} slots={slots} round={view.round} />
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
          {[...view.history].reverse().map((r) => {
            const idx = view.history.findIndex((x) => x.round === r.round);
            const prev = idx > 0 ? view.history[idx - 1] : null;
            return (
              <RoundCard
                key={r.round}
                record={r}
                teams={teams}
                slots={slots}
                dimensions={view.meta?.dimensions ?? []}
                board={board}
                prevScores={prev?.verdict?.scores ?? null}
              />
            );
          })}

          {view.judgeChunks.length > 0 && !view.finish && (
            <article className="panel px-4 py-3">
              <div className="label mb-1.5">裁判推演</div>
              <p className="mono whitespace-pre-wrap text-[11px] leading-relaxed text-fg-dim/80">
                {view.judgeChunks.join("")}
              </p>
            </article>
          )}
        </section>

        {showDm && (
          <aside className="min-w-0 space-y-3 lg:sticky lg:top-20 lg:self-start">
            <DmPanel
              matchId={matchId}
              teams={teams}
              paused={view.phase === "paused"}
              disabled={view.phase === "done"}
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
