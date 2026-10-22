"use client";

import { useState } from "react";
import type { BoardSpec } from "@/engine/types";
import { StateChips } from "./arena-board";
import { EffortChip, ModelMetaLine, SlotRows, ThinkingBody, ThinkingCount } from "./arena-blocks";

export interface SlotDef {
  key: string;
  label: string;
  type: "text" | "number" | "choice";
  reveal: "public" | "secret";
  required: boolean;
}

export interface MemberView {
  id: string;
  seat: number;
  display: string;
  provider: string;
  modelId: string;
  /** Provider protocol, temperature and output ceiling, read from the frozen snapshot. */
  kind?: string | null;
  temperature?: number | null;
  thinkingBudget?: number | null;
  /** Configured thinking strength, if any; shown so the audience knows the dial. */
  reasoning?: string | null;
  status: "idle" | "thinking" | "ready" | "forfeit";
  thinking: string[];
  thinkingDone: boolean;
  content: Record<string, unknown> | null;
  usage?: { promptTokens: number; completionTokens: number } | null;
  latencyMs?: number | null;
  forfeitReason?: string | null;
}

export interface TeamView {
  id: string;
  idx: number;
  name: string;
  color: string;
  members: MemberView[];
  total: number;
  roundScore: number;
}

export interface RoundView {
  round: number;
  sudden: boolean;
  submissions: Array<{
    participantId: string;
    seat: number;
    teamId: string;
    display: string;
    modelId: string;
    reasoning?: string | null;
    usage?: { promptTokens: number; completionTokens: number } | null;
    latencyMs?: number | null;
    status: string;
    content: Record<string, unknown>;
    thinking: string;
  }>;
  verdict: {
    publicSummary: string;
    verdict: string;
    scores: Array<{
      teamId: string;
      weighted: number;
      notes: string;
      dimensions: Record<string, number>;
      state?: Record<string, number>;
    }>;
    judge: string;
    marks?: number[];
    suddenWinnerTeamId?: string | null;
  } | null;
  /** Judge's own stream for this round, kept so the audience can audit a verdict. */
  judgeThinking: string;
  teamScores: Record<string, number>;
}

export function MemberCard({
  member,
  slots,
  round,
  color,
}: {
  member: MemberView;
  slots: SlotDef[];
  round: number;
  color: string;
}) {
  const forfeited = member.status === "forfeit";
  const secretCount = slots.filter((s) => s.reveal === "secret").length;
  const entryCount = member.content ? Object.keys(member.content).length : slots.length;
  const submitState = forfeited
    ? "弃权"
    : member.content
      ? `${entryCount} 项${secretCount ? ` · ${secretCount} 暗项` : ""}`
      : member.status === "thinking"
        ? `第 ${round} 轮推演中`
        : "等待出招";

  return (
    <div
      className={`flex flex-1 flex-col rounded-lg border bg-ink-1/60 transition ${forfeited ? "opacity-60" : ""}`}
      style={{ borderColor: `${color}26` }}
    >
      <div className="px-3 pt-2.5">
        <div className="flex items-start gap-2">
          <span
            className="mono mt-[1px] flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-[10px]"
            style={{ backgroundColor: `${color}18`, color }}
          >
            {member.seat}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate text-[13px] font-semibold leading-tight text-fg" title={member.display}>
                {member.display}
              </span>
              {member.provider && (
                <span className="shrink-0 rounded border border-line px-1.5 py-[1px] text-[10px] text-fg-faint">
                  {member.provider}
                </span>
              )}
              <EffortChip effort={member.reasoning} budget={member.thinkingBudget} />
            </div>
          </div>
          <StatusDot status={member.status} />
        </div>
      </div>

      <ModelMetaLine member={member} />

      <div className="flex flex-1 flex-col gap-2 px-2.5 pb-2.5">
        <section className="rounded-md border border-line/70 bg-ink-0/35">
          <header className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-2">
            <span className="label">思考</span>
            <ThinkingCount member={member} />
          </header>
          <div className="px-2.5 pb-2.5">
            <ThinkingBody
              text={member.thinking.join("")}
              done={member.thinkingDone}
              autoScroll={member.status === "thinking"}
              placeholder={
                forfeited ? "本轮思考中断" : member.status === "thinking" ? "正在写：为什么这么选…" : "尚未开口"
              }
            />
          </div>
        </section>

        <section
          className={`rounded-md border ${
            forfeited ? "border-blood/20 bg-blood/[0.03]" : "border-jade/20 bg-jade/[0.04]"
          }`}
        >
          <header className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-2">
            <span className="label">出招</span>
            <span className="mono text-[10px] text-fg-faint">{submitState}</span>
          </header>
          <div className="px-2.5 pb-2">
            {forfeited ? (
              <p
                className="truncate py-1 text-[11px] text-blood"
                title={member.forfeitReason ?? "本轮弃权"}
              >
                本轮弃权{member.forfeitReason ? ` · ${member.forfeitReason}` : ""}
              </p>
            ) : member.content ? (
              <SlotRows slots={slots} content={member.content} />
            ) : (
              <p className="py-1.5 text-[11px] text-fg-faint">尚未提交</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: MemberView["status"] }) {
  const map = {
    idle: { text: "待命", cls: "text-fg-faint" },
    thinking: { text: "思考", cls: "text-amber" },
    ready: { text: "已就位", cls: "text-jade" },
    forfeit: { text: "弃权", cls: "text-blood" },
  } as const;
  const s = map[status];
  return <span className={`mono text-[10px] ${s.cls}`}>{s.text}</span>;
}

export function TeamColumn({
  team,
  slots,
  round,
}: {
  team: TeamView;
  slots: SlotDef[];
  round: number;
}) {
  return (
    <section className="panel flex min-w-0 flex-col overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: team.color }} />
          <h2 className="truncate text-[14px] font-semibold" style={{ color: team.color }}>
            {team.name}
          </h2>
          <span className="mono text-[10px] text-fg-faint">{team.members.length} 人</span>
          <span className="mono ml-auto text-[15px] tabular-nums" style={{ color: team.color }}>
            {team.total.toFixed(2)}
          </span>
        </div>
        <div className="mono mt-1 text-[10px] text-fg-faint">
          本轮 {team.roundScore.toFixed(2)} · 累计 {team.total.toFixed(2)}
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-2 p-2.5">
        {team.members.map((m) => (
          <MemberCard key={m.id} member={m} slots={slots} round={round} color={team.color} />
        ))}
      </div>
    </section>
  );
}

export function RoundCard({
  record,
  teams,
  slots,
  dimensions,
  board,
  prevScores,
}: {
  record: RoundView;
  teams: TeamView[];
  slots: SlotDef[];
  dimensions: Array<{ key: string; label: string }>;
  board?: BoardSpec | null;
  /** Previous round's score lines, used only for the per-meter delta. */
  prevScores?: Array<{ teamId: string; state?: Record<string, number> }> | null;
}) {
  const teamOf = (teamId: string) => teams.find((t) => t.id === teamId);
  const nameOf = (teamId: string) => teamOf(teamId)?.name ?? "某方";
  const colorOf = (teamId: string) => teamOf(teamId)?.color ?? "var(--fg-dim)";
  const suddenWinner = record.verdict?.suddenWinnerTeamId
    ? teamOf(record.verdict.suddenWinnerTeamId)
    : undefined;

  return (
    <article className="panel px-4 py-3.5">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="mono text-[11px] text-fg-faint">R{String(record.round).padStart(2, "0")}</span>
        {record.sudden && <span className="rounded border border-amber/40 px-1.5 text-[10px] text-amber">加时</span>}
        {suddenWinner && (
          <span
            className="rounded border px-1.5 text-[10px]"
            style={{ color: suddenWinner.color, borderColor: `${suddenWinner.color}55` }}
          >
            {suddenWinner.name} 定胜负
          </span>
        )}
        <span className="h-px flex-1 bg-line" />
        {record.verdict && (
          <span className="mono text-[10px] text-fg-faint">裁判 {record.verdict.judge || "—"}</span>
        )}
      </div>

      {record.verdict?.publicSummary && (
        <p className="mb-2.5 text-[13px] leading-relaxed text-fg/90">「{record.verdict.publicSummary}」</p>
      )}

      <div className="space-y-2">
        {record.submissions.map((s) => (
          <div key={s.participantId} className="rounded-lg border border-line/70 bg-ink-1/45 px-2.5 py-2">
            <div className="mb-1 flex flex-wrap items-baseline gap-2">
              <span className="mono text-[10px] text-fg-faint">#{s.seat}</span>
              <span className="truncate text-[12px] font-medium" style={{ color: colorOf(s.teamId) }}>
                {s.display || nameOf(s.teamId)}
              </span>
              {s.modelId && (
                <span className="mono min-w-0 truncate text-[10px] text-fg-faint" title={s.modelId}>
                  {s.modelId}
                </span>
              )}
              <EffortChip effort={s.reasoning} />
              {s.usage && (
                <span className="mono shrink-0 text-[10px] text-fg-faint">
                  ↑{s.usage.promptTokens} ↓{s.usage.completionTokens}
                  {s.latencyMs != null ? ` · ${(s.latencyMs / 1000).toFixed(1)}s` : ""}
                </span>
              )}
              <span
                className={`mono ml-auto shrink-0 text-[10px] ${
                  s.status === "forfeit" ? "text-blood" : "text-jade"
                }`}
              >
                {s.status === "forfeit" ? "弃权" : "已就绪"}
              </span>
            </div>

            {s.status === "forfeit" ? (
              <p className="py-1 text-[11px] text-blood">本轮弃权</p>
            ) : (
              <SlotRows slots={slots} content={s.content} />
            )}

            {s.thinking && (
              <details className="group mt-1.5">
                <summary className="cursor-pointer list-none text-[10px] text-fg-faint transition hover:text-fg-dim [&::-webkit-details-marker]:hidden">
                  思考 · {s.thinking.length} 字
                  <span className="ml-1 group-open:hidden">▸</span>
                  <span className="ml-1 hidden group-open:inline">▾</span>
                </summary>
                <div className="mt-1.5 rounded border border-line/60 bg-ink-0/40 px-2.5 py-2">
                  <ThinkingBody text={s.thinking} done placeholder="" />
                </div>
              </details>
            )}
          </div>
        ))}
      </div>

      {record.verdict && record.verdict.scores.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-line pt-2.5">
          {record.verdict.scores.map((line) => (
            <div key={line.teamId}>
              <div className="flex items-baseline gap-2">
                <span className="mono w-14 shrink-0 truncate text-[11px]" style={{ color: colorOf(line.teamId) }}>
                  {nameOf(line.teamId)}
                </span>
                <span className="mono text-[13px] tabular-nums text-fg">{line.weighted.toFixed(2)}</span>
                <span className="min-w-0 truncate text-[11px] text-fg-faint" title={line.notes}>
                  {line.notes}
                </span>
              </div>
              <StateChips
                board={board}
                state={line.state}
                prevState={prevScores?.find((p) => p.teamId === line.teamId)?.state}
              />
              {dimensions.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {dimensions.map((d) => {
                    const value = line.dimensions?.[d.key];
                    return (
                      <span
                        key={d.key}
                        className="rounded border border-line px-1.5 py-[1px] text-[10px] text-fg-faint"
                      >
                        {d.label}{" "}
                        <span className="mono tabular-nums text-fg-dim">
                          {Number.isFinite(value) ? value.toFixed(1) : "—"}
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {record.judgeThinking && (
        <details className="group mt-2 border-t border-line pt-2">
          <summary className="cursor-pointer list-none text-[10px] text-fg-faint transition hover:text-fg-dim [&::-webkit-details-marker]:hidden">
            裁判推演 · {record.judgeThinking.length} 字
            <span className="ml-1 group-open:hidden">▸</span>
            <span className="ml-1 hidden group-open:inline">▾</span>
          </summary>
          <div className="mt-1.5 max-h-[260px] overflow-y-auto rounded border border-line/60 bg-ink-0/40 px-2.5 py-2">
            <p className="whitespace-pre-wrap break-words text-[11px] leading-[1.75] text-fg-dim">
              {record.judgeThinking}
            </p>
          </div>
        </details>
      )}
    </article>
  );
}

export function DmPanel({
  matchId,
  teams,
  paused,
  disabled,
}: {
  matchId: string;
  teams: TeamView[];
  paused: boolean;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/matches/${matchId}/intervene`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      setToast(data.ok ? "已落库，下一轮生效" : (data.error ?? "失败"));
    } catch {
      setToast("发送失败");
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2400);
    }
  }

  return (
    <div className="panel flex flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <span className="label">场外 · DM</span>
        {paused && <span className="mono text-[10px] text-amber">PAUSED</span>}
      </div>

      <button
        disabled={disabled || busy}
        onClick={() => send({ kind: paused ? "resume" : "pause" })}
        className="rounded-md border border-line px-3 py-2 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg disabled:opacity-40"
      >
        {paused ? "继续对局" : "暂停对局"}
      </button>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="对场上说一句话，所有人都听得到"
          className="w-full resize-none rounded-md border border-line bg-ink-1 px-2.5 py-2 text-[12px] text-fg outline-none placeholder:text-fg-faint focus:border-jade/40"
        />
        <button
          disabled={disabled || busy || !text.trim()}
          onClick={async () => {
            await send({ kind: "say", text: text.trim() });
            setText("");
          }}
          className="w-full rounded-md border border-jade/30 bg-jade/10 px-3 py-2 text-[12px] text-jade transition hover:bg-jade/15 disabled:opacity-40"
        >
          插话
        </button>
      </div>

      <div className="space-y-1.5 border-t border-line pt-3">
        <span className="label">给某方加分</span>
        <div className="flex flex-wrap gap-1.5">
          {teams.map((t) => (
            <button
              key={t.id}
              disabled={disabled || busy}
              onClick={() => send({ kind: "score", teamId: t.id, delta: 0.5 })}
              className="rounded border border-line px-2 py-1 text-[11px] transition hover:border-line-strong disabled:opacity-40"
              style={{ color: t.color }}
            >
              {t.name} +0.5
            </button>
          ))}
        </div>
      </div>

      {toast && <p className="mono text-[10px] text-fg-faint">{toast}</p>}
    </div>
  );
}
