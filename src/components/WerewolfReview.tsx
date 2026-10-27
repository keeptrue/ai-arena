"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  REVIEW_DEFAULT_WEIGHTS,
  REVIEW_DIMENSION_COPY,
  ROLE_LABEL,
  ballotRow,
  ballotTotal,
  cleanNative,
  reviewActiveStreams,
  reviewLiveCounts,
  reviewProgress,
  reviewRaterState,
  reviewSeat,
  reviewStream,
  reviewWeights,
  seatModel,
  seatModelTitle,
  type ReviewRubric,
  type TableReview,
  type TableReviewBallot,
  type TableReviewSeatResult,
  type TableReviewStream,
  type TableSeatView,
} from "@/lib/werewolf-frame";

/* ── small parts ───────────────────────────────────────────────────── */

type Tone = "jade" | "amber" | "blood" | "ghost";

const TONE: Record<Tone, string> = {
  jade: "border-jade/35 bg-jade/10 text-jade",
  amber: "border-amber/35 bg-amber/10 text-amber",
  blood: "border-blood/35 bg-blood/10 text-blood",
  ghost: "border-ghost/35 bg-ghost/10 text-ghost",
};

function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] leading-none ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-[12px] transition-colors ${
        active
          ? "bg-ink-3 text-fg"
          : "text-fg-faint hover:bg-ink-2 hover:text-fg-dim"
      }`}
    >
      {children}
    </button>
  );
}

function total(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

/** "01:23" — a review takes minutes, not milliseconds. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function charCount(n: number): string {
  if (n < 1_000) return `${n} 字`;
  return `${(n / 1_000).toFixed(1)}k 字`;
}

/** Seconds a rater has been thinking, once both clocks are known. */
function elapsedSeconds(stream: TableReviewStream | null, now: number | null): number | null {
  if (!stream?.startedAt || now === null) return null;
  return Math.max(0, Math.round((now - stream.startedAt) / 1000));
}

function streamChars(stream: TableReviewStream | null): number {
  return stream ? stream.reasonChars + stream.noteChars : 0;
}

function raterTitle(seats: TableSeatView[], rater: number | "judge", judgeName: string | null): string {
  if (rater === "judge") return judgeName ? `裁判 · ${judgeName}` : "裁判";
  return `${rater + 1}号 · ${seatName(seats, rater)}`;
}

function seatName(seats: TableSeatView[], seat: number): string {
  // Every seat label in the panel names its model; only a roster row that never
  // existed falls back to the seat number.
  return seatModel(seats, seat) || `${seat + 1}号`;
}

function roleName(seats: TableSeatView[], seat: number): string {
  const role = reviewSeat({ seats }, seat)?.role;
  return role ? ROLE_LABEL[role] : "—";
}

/** The house rubric, used until `review.opened` says what this table actually runs. */
const HOUSE_RUBRIC: ReviewRubric = {
  weights: REVIEW_DEFAULT_WEIGHTS,
  selfWeight: 0,
  judgeVotes: 2,
  trim: true,
  minBallots: 4,
};

/* ── component ─────────────────────────────────────────────────────── */

export function WerewolfReview({
  review,
  seats,
  matchId,
  finished,
  judgeName,
  live,
  resumable,
  onRefresh,
  exportMode = false,
}: {
  review: TableReview;
  seats: TableSeatView[];
  matchId: string;
  finished: boolean;
  judgeName: string | null;
  /** A review process is driving this match right now. */
  live: boolean;
  /** Opened, unfinished, and nothing driving it: the continue button belongs here. */
  resumable: boolean;
  onRefresh: () => void;
  /** Frozen file: show the scores, never the buttons that would spend a call. */
  exportMode?: boolean;
}) {
  const [tab, setTab] = useState<"board" | "judges" | "rubric">("board");
  const [openRater, setOpenRater] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ten ballots are ten concurrent calls; this panel is where the audience watches
  // them think. The clock starts after mount and only ticks while something is
  // actually being written, so the server-rendered markup never prints a client
  // timestamp and an interrupted review does not keep a timer alive.
  const streaming =
    finished && !review.verdict && (live || Object.keys(review.streams).length > 0);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [streaming]);
  const clockNow = streaming ? now : null;

  const verdict = review.verdict;
  const weights = reviewWeights(review);
  const rubric = review.rubric ?? HOUSE_RUBRIC;

  const judgeExpected =
    !!judgeName ||
    review.raters.includes("judge") ||
    review.expected >= 10 ||
    verdict?.raters.judge === true;

  const progress = reviewProgress(review, { judge: judgeExpected });
  const started = review.attempt > 0 || review.opened || review.ballots.length > 0 || !!verdict;
  // While ballots are still coming in, a judge that has not voted yet is just
  // "pending" — only a closed attempt without a judge ballot is worth a warning.
  const judgeMissing =
    judgeExpected &&
    (verdict ? !verdict.judge : !live && !progress.pending.includes("judge"));

  const ranking = verdict?.ranking ?? [];
  const podium = ranking.slice(0, 3);

  if (!finished) return null;

  const status: { label: string; tone: Tone } = verdict
    ? verdict.provisional
      ? { label: "样本不足", tone: "amber" }
      : progress.failed > 0 || verdict.raters.missing.length > 0 || verdict.reason === "partial"
        ? { label: "部分评分", tone: "amber" }
        : { label: "已完成", tone: "jade" }
    : started
      ? {
          label: exportMode
            ? `未完成 ${progress.done}/${progress.expected}`
            : `评分中 ${progress.done}/${progress.expected}`,
          tone: live ? "jade" : "amber",
        }
      : { label: "未评分", tone: "ghost" };

  async function run(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        error?: string;
      };
      // An aborted match never finished, so its review is a deliberate spend: ask
      // before burning ten calls. `force` is the caller saying yes.
      if (data.status === "aborted" && !force) {
        if (window.confirm("这一局是中止结束的，仍要花 10 次调用评分？")) {
          await run(true);
        }
        return;
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error ?? `评分请求被拒绝（${data.status ?? res.status}）`);
      }
      // The ballots arrive over SSE; this re-reads the log for the page that was
      // opened after the fact, and refreshes the live / resumable flags.
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function reScore() {
    if (!window.confirm(`重新评分会作废这一轮的所有票，再调用 ${progress.expected || 10} 次模型。确定？`)) return;
    void run(true);
  }

  const action = exportMode ? null : verdict ? (
    <button
      type="button"
      onClick={reScore}
      disabled={busy || live}
      title="作废这一轮，重新叫 10 个评委"
      className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition-colors hover:border-blood/50 hover:text-blood disabled:opacity-40"
    >
      {busy ? "提交中…" : "重新评分"}
    </button>
  ) : started ? (
    live ? (
      <span className="rounded-md border border-jade/30 bg-jade/10 px-3 py-1.5 text-[12px] text-jade">
        评分进行中…
      </span>
    ) : (
      <button
        type="button"
        onClick={() => void run(false)}
        disabled={busy || !resumable}
        title={resumable ? "接着把没交的票叫回来" : "这一轮没有可续的进度"}
        className="rounded-md border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade transition-colors hover:bg-jade/15 disabled:opacity-40"
      >
        {busy ? "提交中…" : "继续评分"}
      </button>
    )
  ) : (
    <button
      type="button"
      onClick={() => void run(false)}
      disabled={busy}
      className="rounded-md bg-jade px-4 py-2 text-[12px] font-medium text-ink-0 transition-colors hover:bg-jade/90 disabled:opacity-40"
    >
      {busy ? "开局中…" : `开始赛后评分（${progress.expected || 10} 次调用）`}
    </button>
  );

  return (
    // The panel sits right under the reel, whose frame captions reach past their
    // own box at narrow widths. A solid surface keeps this block readable instead
    // of showing the table through it.
    <section
      className="panel mt-4 px-4 py-4"
      style={{ backgroundColor: "var(--color-ink-1)" }}
      aria-label="赛后评分"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">赛后评分</span>
            <Chip tone={status.tone}>{status.label}</Chip>
            {judgeName && (
              <span className="text-[11px] text-fg-dim">
                裁判 <span className="text-fg">{judgeName}</span>
              </span>
            )}
            {judgeMissing && (
              <Chip tone="amber" title="裁判票没交上来，本轮按 9 人互评出分">
                无裁判票
              </Chip>
            )}
            {verdict?.provisional && (
              <Chip tone="amber" title={`有效玩家票少于 ${rubric.minBallots} 张`}>
                非正式
              </Chip>
            )}
            {!verdict && started && !live && (
              <Chip tone="amber" title="评分进程已经不在了，点「继续评分」只补叫欠票的评委">
                已中断
              </Chip>
            )}
          </div>
          <h2 className="mt-1.5 text-[15px] font-medium tracking-tight">谁最会玩</h2>
          <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-fg-dim">
            终局翻牌之后，{progress.expected || 10} 个视角各自盲评这一桌。
            评分不改写任何对局事实，也不进 prompt 的下一局。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{action}</div>
      </header>

      {error && (
        <p className="mt-3 rounded-md border border-blood/30 bg-blood/[0.06] px-3 py-2 text-[12px] text-blood">
          {error}
        </p>
      )}

      {!started ? (
        <p className="mt-3 rounded-md border border-line bg-ink-1/50 px-3 py-2 text-[12px] text-fg-faint">
          {exportMode
            ? "这一局没有赛后评分。"
            : `这一桌还没有评分。开始后会为 ${judgeExpected ? "9 个座位和 1 个裁判" : "9 个座位"} 各调用一次模型，读完公开记录再各自打分；中途可以继续，也可以在任何时候重新评。`}
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1 rounded-md border border-line bg-ink-1 p-0.5" role="tablist">
            <Tab active={tab === "board"} onClick={() => setTab("board")}>
              总榜
            </Tab>
            <Tab active={tab === "judges"} onClick={() => setTab("judges")}>
              评委明细
              <span className="mono ml-1 text-[10px] text-fg-faint">
                {progress.done}/{progress.expected}
              </span>
            </Tab>
            <Tab active={tab === "rubric"} onClick={() => setTab("rubric")}>
              评分标准
            </Tab>
          </div>

          {tab === "board" &&
            (verdict ? (
              <>
                {podium.length > 0 && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {podium.map((row, i) => (
                      <PodiumCard
                        key={row.seat}
                        row={row}
                        place={i + 1}
                        name={seatName(seats, row.seat)}
                        role={roleName(seats, row.seat)}
                        mvp={verdict.mvp === row.seat && row.mvpVotes > 0}
                        provisional={verdict.provisional}
                      />
                    ))}
                  </div>
                )}

                {ranking.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[860px] border-collapse text-[12px]">
                      <thead>
                        <tr className="text-[10px] text-fg-faint">
                          <th className="w-10 border-b border-line px-1 py-2 text-left font-normal">#</th>
                          <th className="border-b border-line px-2 py-2 text-left font-normal">座位 · 模型</th>
                          <th className="w-16 border-b border-line px-2 py-2 text-left font-normal">身份</th>
                          {REVIEW_DIMENSION_COPY.map((d) => (
                            <th key={d.key} className="w-14 border-b border-line px-2 py-2 text-right font-normal">
                              {d.label}
                            </th>
                          ))}
                          <th className="w-16 border-b border-line px-2 py-2 text-right font-normal">总分</th>
                          <th className="w-14 border-b border-line px-2 py-2 text-right font-normal">裁判</th>
                          <th className="w-14 border-b border-line px-2 py-2 text-right font-normal">自评</th>
                          <th className="w-14 border-b border-line px-2 py-2 text-right font-normal">MVP票</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ranking.map((row) => {
                          const best = row.rank === 1;
                          const mvp = verdict.mvp === row.seat && row.mvpVotes > 0;
                          return (
                            <tr
                              key={row.seat}
                              className={best ? "bg-jade/[0.05]" : "hover:bg-ink-2/60"}
                            >
                              <td className="mono border-b border-line/60 px-1 py-2 text-fg-faint">
                                {row.rank}
                                {row.tied ? "=" : ""}
                              </td>
                              <td className="border-b border-line/60 px-2 py-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="mono text-fg-faint">{row.seat + 1}号</span>
                                  <span className={best ? "text-fg" : "text-fg-dim"}>
                                    {seatName(seats, row.seat)}
                                  </span>
                                  {best && <Chip tone="jade">最会玩</Chip>}
                                  {mvp && <Chip tone="ghost">同行 MVP</Chip>}
                                  {verdict.provisional && <Chip tone="amber">非正式</Chip>}
                                </div>
                              </td>
                              <td className="w-16 border-b border-line/60 px-2 py-2 text-fg-dim">
                                {roleName(seats, row.seat)}
                              </td>
                              <td className="mono border-b border-line/60 px-2 py-2 text-right text-fg-dim">
                                {row.read.toFixed(1)}
                              </td>
                              <td className="mono border-b border-line/60 px-2 py-2 text-right text-fg-dim">
                                {row.voice.toFixed(1)}
                              </td>
                              <td className="mono border-b border-line/60 px-2 py-2 text-right text-fg-dim">
                                {row.craft.toFixed(1)}
                              </td>
                              <td className="mono border-b border-line/60 px-2 py-2 text-right text-fg-dim">
                                {row.poise.toFixed(1)}
                              </td>
                              <td
                                className={`mono border-b border-line/60 px-2 py-2 text-right text-[13px] ${
                                  best ? "text-jade" : "text-fg"
                                }`}
                              >
                                {row.total.toFixed(1)}
                              </td>
                              <td className="mono border-b border-line/60 px-2 py-2 text-right text-fg-faint">
                                {total(row.judgeTotal)}
                              </td>
                              <td className="mono border-b border-line/60 px-2 py-2 text-right text-fg-faint">
                                {total(row.selfTotal)}
                              </td>
                              <td className="mono border-b border-line/60 px-2 py-2 text-right text-fg-dim">
                                {row.mvpVotes}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 rounded-md border border-amber/30 bg-amber/[0.06] px-3 py-2 text-[12px] text-amber">
                    这一轮没有可用的票（{verdict.reason ?? "未达到出分条件"}），所以只看得到进度与明细。
                  </p>
                )}

                <SpecialVotes verdict={verdict} seats={seats} judgeName={judgeName} />

                <p className="mt-3 text-[11px] leading-relaxed text-fg-faint">
                  总分为四维加权（判断 {pct(weights.read)} · 表达 {pct(weights.voice)} · 操作{" "}
                  {pct(weights.craft)} · 抗压 {pct(weights.poise)}）后的结果；
                  {rubric.trim ? "每席剔除一张最高、一张最低的同行票" : "未开启去极值"}；
                  裁判一票按 {rubric.judgeVotes} 票计；自评
                  {rubric.selfWeight > 0 ? `按 ${pct(rubric.selfWeight)} 计入` : "只展示，不计入总分"}。
                </p>
              </>
            ) : (
              <ProgressBoard
                review={review}
                seats={seats}
                judgeName={judgeName}
                judgeExpected={judgeExpected}
                progress={progress}
                now={clockNow}
                live={live}
              />
            ))}

          {tab === "judges" && (
            <JudgesPanel
              review={review}
              seats={seats}
              weights={weights}
              judgeName={judgeName}
              judgeExpected={judgeExpected}
              open={openRater}
              onToggle={(key) => setOpenRater((cur) => (cur === key ? null : key))}
              now={clockNow}
              live={live}
            />
          )}

          {tab === "rubric" && (
            <RubricPanel rubric={rubric} weights={weights} judgeExpected={judgeExpected} />
          )}
        </>
      )}
    </section>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/* ── leaderboard pieces ────────────────────────────────────────────── */

function PodiumCard({
  row,
  place,
  name,
  role,
  mvp,
  provisional,
}: {
  row: TableReviewSeatResult;
  place: number;
  name: string;
  role: string;
  mvp: boolean;
  provisional: boolean;
}) {
  const lead = place === 1;
  return (
    <div
      className={`rounded-lg border p-3 ${
        lead ? "border-jade/40 bg-jade/[0.06]" : "border-line bg-ink-1/60"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`mono text-[10px] ${lead ? "text-jade" : "text-fg-faint"}`}>
          0{place}
        </span>
        <span className="mono truncate text-[11px] text-fg-faint">{role}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
        <span className="mono text-[12px] text-fg-faint">{row.seat + 1}号</span>
        <span className={`truncate text-[13px] ${lead ? "text-fg" : "text-fg-dim"}`}>{name}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className={`mono text-[24px] leading-none ${lead ? "text-jade" : "text-fg"}`}>
          {row.total.toFixed(1)}
        </span>
        <span className="mono text-[10px] text-fg-faint">
          判断 {row.read.toFixed(1)} · 表达 {row.voice.toFixed(1)}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {lead && <Chip tone="jade">最会玩</Chip>}
        {mvp && <Chip tone="ghost">同行 MVP</Chip>}
        {provisional && <Chip tone="amber">非正式</Chip>}
      </div>
    </div>
  );
}

function SpecialVotes({
  verdict,
  seats,
  judgeName,
}: {
  verdict: NonNullable<TableReview["verdict"]>;
  seats: TableSeatView[];
  judgeName: string | null;
}) {
  const items = [
    { key: "mvp", label: "同行 MVP", seat: verdict.mvp, tone: "ghost" as Tone },
    { key: "speech", label: "最会说", seat: verdict.bestSpeech, tone: "jade" as Tone },
    { key: "deception", label: "最会骗", seat: verdict.bestDeception, tone: "amber" as Tone },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line bg-ink-1/50 px-3 py-2">
      <span className="label">特别票</span>
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-1.5 text-[11px] text-fg-dim">
          <Chip tone={item.tone}>{item.label}</Chip>
          {item.seat === null ? (
            <span className="mono text-fg-faint">—</span>
          ) : (
            <span className="mono">
              {item.seat + 1}号
              <span className="ml-1 text-fg-faint">{seatName(seats, item.seat)}</span>
            </span>
          )}
        </span>
      ))}
      <span className="ml-auto text-[10px] text-fg-faint">
        票源 {verdict.raters.players} 玩家{judgeName ? " + 裁判" : ""}
      </span>
    </div>
  );
}

/* ── progress ──────────────────────────────────────────────────────── */

function ProgressBoard({
  review,
  seats,
  judgeName,
  judgeExpected,
  progress,
  now,
  live,
}: {
  review: TableReview;
  seats: TableSeatView[];
  judgeName: string | null;
  judgeExpected: boolean;
  progress: ReturnType<typeof reviewProgress>;
  now: number | null;
  live: boolean;
}) {
  const counts = reviewLiveCounts(review, { judge: judgeExpected });
  const roster: Array<number | "judge"> = Array.from({ length: 9 }, (_, seat) => seat);
  if (judgeExpected) roster.push("judge");
  const waited =
    now !== null && review.openedAt !== null ? Math.max(0, now - review.openedAt) : null;

  const statusOf = (rater: number | "judge"): { label: string; tone: Tone; title: string } => {
    const ballot = review.ballots.find((b) => b.rater === rater) ?? null;
    const state = reviewRaterState(review, rater);
    const stream = reviewStream(review, rater);
    const chars = streamChars(stream);
    const seconds = elapsedSeconds(stream, now);
    if (state === "done") return { label: "已交", tone: "jade", title: "票已落库" };
    if (state === "forfeit") {
      return { label: "弃权", tone: "amber", title: ballot?.error || "这一票没有结果" };
    }
    if (state === "thinking") {
      if (!live) return { label: "已中断", tone: "amber", title: `${charCount(chars)}写到这里，进程已不在` };
      const spent = seconds !== null ? `${seconds}s · ` : "";
      return { label: `思考 ${spent}${charCount(chars)}`, tone: "jade", title: "正在读牌桌，票还没落" };
    }
    return live
      ? { label: "排队", tone: "ghost", title: "还没轮到它，并发满了" }
      : { label: "未交", tone: "ghost", title: "这一票没有结果" };
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-ink-1/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] text-fg">
          正在收集 {progress.done}/{progress.expected} 张票
        </span>
        <span className="mono text-[11px] text-fg-faint">
          {Math.round(progress.ratio * 100)}% · 第 {review.attempt} 轮
          {waited !== null && ` · 已等 ${clock(waited)}`}
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink-3">
        <div
          className="h-full rounded-full bg-jade/70 transition-[width] duration-300"
          style={{ width: `${Math.round(progress.ratio * 100)}%` }}
        />
      </div>
      {(live || counts.failed > 0 || counts.chars > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {live && (
            <span className="text-fg-dim">
              {counts.thinking > 0 ? `${counts.thinking} 席正在评分` : "等待评委开口"}
              {counts.queued > 0 ? ` · ${counts.queued} 席排队` : ""}
            </span>
          )}
          {counts.failed > 0 && <span className="text-amber">{counts.failed} 票弃权</span>}
          {counts.chars > 0 && (
            <span className="mono text-fg-faint">已写 {charCount(counts.chars)}</span>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {roster.map((rater) => {
          const status = statusOf(rater);
          const label =
            rater === "judge"
              ? `裁判${judgeName ? ` ${judgeName}` : ""}`
              : `${Number(rater) + 1}号 ${seatName(seats, Number(rater))}`;
          return (
            <span
              key={String(rater)}
              title={status.title}
              className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 text-[11px] text-fg-dim"
            >
              <span className="truncate">{label}</span>
              <span
                className={`mono text-[10px] ${
                  status.tone === "jade"
                    ? "text-jade"
                    : status.tone === "amber"
                      ? "text-amber"
                      : "text-fg-faint"
                }`}
              >
                {status.label}
              </span>
            </span>
          );
        })}
      </div>
      <ReviewLive review={review} seats={seats} now={now} live={live} />
      <p className="mt-2.5 text-[11px] leading-relaxed text-fg-faint">
        每个评委只读公开记录与终局翻牌，看不到模型名、看不到别人的票。
        票齐了自动出分；一票没交只影响自己的那票。
      </p>
    </div>
  );
}

/* ── live review streams ───────────────────────────────────────────── */

/**
 * The ten ballots as they are being written. Only the tail of each call is kept:
 * a review deliberation can run tens of thousands of characters, and the panel is
 * a window onto the newest line, not an archive.
 */
function ReviewLive({
  review,
  seats,
  now,
  live,
}: {
  review: TableReview;
  seats: TableSeatView[];
  now: number | null;
  live: boolean;
}) {
  const streams = reviewActiveStreams(review);
  if (streams.length === 0) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-line bg-ink-1/40 px-3 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="label">评分推演</span>
          <span className="text-[11px] text-fg-faint">
            {live ? "评委已叫上，等待第一段思考…" : "没有进行中的推演"}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-line bg-ink-1/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="label">评分推演</span>
        <span className="text-[11px] text-fg-faint">
          {streams.length} 席正在看牌桌 · 只显示尾部
        </span>
      </div>
      <div className="mt-2 grid gap-2 xl:grid-cols-2">
        {streams.map((stream) => (
          <ReviewStreamCard
            key={stream.rater === "judge" ? "judge" : `seat:${stream.rater}`}
            stream={stream}
            seats={seats}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

function ReviewStreamCard({
  stream,
  seats,
  now,
}: {
  stream: TableReviewStream;
  seats: TableSeatView[];
  now: number | null;
}) {
  // Reasoning is the interesting half; a model with no reasoning channel is
  // visibly writing its JSON ballot instead.
  const channel = stream.reasonChars > 0 ? "reason" : "note";
  const text = cleanNative(channel === "reason" ? stream.reason : stream.note);
  const chars = streamChars(stream);
  const seconds = elapsedSeconds(stream, now);
  return (
    <div className="min-w-0 rounded border border-line/70 bg-ink-1/60 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="mono text-[11px] text-fg-faint">
          {stream.rater === "judge" ? "裁判" : `${Number(stream.rater) + 1}号`}
        </span>
        <span className="min-w-0 truncate text-[12px] text-fg-dim">
          {stream.rater === "judge" ? "评审席" : seatName(seats, Number(stream.rater))}
        </span>
        <Chip tone={channel === "reason" ? "jade" : "ghost"}>
          {channel === "reason" ? "思考" : "写票"}
        </Chip>
        <span className="mono ml-auto text-[10px] text-fg-faint">
          {seconds !== null ? `${seconds}s · ` : ""}
          {charCount(chars)}
        </span>
      </div>
      {/* Bottom-aligned: the newest line is the one worth seeing, no scrolling. */}
      <div className="mt-1.5 flex h-[92px] flex-col justify-end overflow-hidden">
        <p
          className={
            channel === "reason"
              ? "whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg-dim"
              : "mono whitespace-pre-wrap break-all text-[10px] leading-relaxed text-fg-faint"
          }
        >
          {text || "…"}
        </p>
      </div>
    </div>
  );
}

/* ── judge matrix ──────────────────────────────────────────────────── */

interface RaterRow {
  key: string;
  rater: number | "judge";
  title: string;
  sub: string;
  ballot: TableReviewBallot | null;
}

function JudgesPanel({
  review,
  seats,
  weights,
  judgeName,
  judgeExpected,
  open,
  onToggle,
  now,
  live,
}: {
  review: TableReview;
  seats: TableSeatView[];
  weights: ReturnType<typeof reviewWeights>;
  judgeName: string | null;
  judgeExpected: boolean;
  open: string | null;
  onToggle: (key: string) => void;
  now: number | null;
  live: boolean;
}) {
  const verdict = review.verdict;
  const rows: RaterRow[] = Array.from({ length: 9 }, (_, seat) => {
    const ballot = review.ballots.find((b) => b.rater === seat) ?? null;
    return {
      key: `seat:${seat}`,
      rater: seat,
      title: `${seat + 1}号 · ${seatName(seats, seat)}`,
      sub: seatName(seats, seat),
      ballot,
    };
  });
  if (judgeExpected) {
    const ballot = review.ballots.find((b) => b.rater === "judge") ?? null;
    rows.push({
      key: "judge",
      rater: "judge",
      title: `裁判${judgeName ? ` · ${judgeName}` : ""}`,
      sub: judgeName ?? "裁判",
      ballot,
    });
  }

  const droppedOf = (seat: number): number[] =>
    verdict?.ranking.find((r) => r.seat === seat)?.dropped ?? [];

  const droppedRows = seats
    .map((seat) => ({ seat: seat.seat, dropped: droppedOf(seat.seat) }))
    .filter((row) => row.dropped.length > 0);

  return (
    <details className="mt-3 rounded-lg border border-line bg-ink-1/50">
      <summary className="cursor-pointer list-none px-3 py-2 text-[12px] text-fg-dim transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
        评委明细 · {review.ballots.filter((b) => b.status === "ok").length} 张票
        <span className="ml-2 text-[11px] text-fg-faint">
          {9} 玩家{judgeExpected ? " + 裁判" : ""} · 9 个座位
        </span>
      </summary>
      <div className="overflow-x-auto px-3 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 pb-1 text-[10px] text-fg-faint">
          <span className="label">四维加权 · 1–10</span>
          <span>
            格内是单张票的四维加权分（1–10）；总榜的「总分」是十张票聚合后的 0–100。
          </span>
        </div>
        <table className="w-full min-w-[820px] border-collapse text-[11px]">
          <thead>
            <tr className="text-[10px] text-fg-faint">
              <th className="sticky left-0 z-10 w-44 border-b border-line bg-ink-1 px-2 py-2 text-left font-normal">
                评委
              </th>
              {seats.map((seat) => (
                <th
                  key={seat.seat}
                  title={seatModelTitle(seats, seat.seat)}
                  className="w-14 border-b border-line px-2 py-2 text-right font-normal"
                >
                  {seat.seat + 1}号
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ballot = row.ballot;
              const ok = ballot?.status === "ok" ? ballot.ballot : null;
              const expanded = open === row.key;
              const hasBallot = !!ok;
              const state = reviewRaterState(review, row.rater);
              const stream = reviewStream(review, row.rater);
              const chars = streamChars(stream);
              const seconds = elapsedSeconds(stream, now);
              const liveState =
                state === "thinking"
                  ? live
                    ? `思考中${seconds !== null ? ` · ${seconds}s` : ""} · ${charCount(chars)}`
                    : `已中断 · ${charCount(chars)}`
                  : live
                    ? "排队等叫"
                    : "未交票";
              return (
                <Fragment key={row.key}>
                  <tr className={row.rater === "judge" ? "bg-ink-2/60" : undefined}>
                    <th scope="row" className="sticky left-0 z-10 w-44 border-b border-line/60 bg-ink-1 px-2 py-1.5 text-left font-normal">
                      <button
                        type="button"
                        onClick={() => hasBallot && onToggle(row.key)}
                        aria-expanded={expanded}
                        disabled={!hasBallot}
                        className={`flex w-full items-center gap-1.5 text-left transition-colors ${
                          hasBallot ? "text-fg-dim hover:text-fg" : "cursor-default text-fg-faint"
                        }`}
                      >
                        <span className="mono text-[10px] text-fg-faint">
                          {hasBallot ? (expanded ? "−" : "+") : "·"}
                        </span>
                        <span className="truncate">{row.title}</span>
                      </button>
                      {!hasBallot && (
                        <span
                          className={`mono block pl-4 text-[10px] ${
                            state === "thinking" ? "text-jade/90" : "text-amber/90"
                          }`}
                        >
                          {ballot?.error ? ballot.error.slice(0, 24) : liveState}
                        </span>
                      )}
                    </th>
                    {seats.map((seat) => {
                      const scoreRow = ballotRow(ok, seat.seat);
                      const value = ballotTotal(scoreRow, weights);
                      const self = row.rater === seat.seat;
                      const dropped = !self && droppedOf(seat.seat).includes(row.rater as number);
                      return (
                        <td
                          key={seat.seat}
                          title={
                            self
                              ? "自评票：只展示，不计入这张座位自己的均值"
                              : dropped
                                ? "极值票：已从该座位的均值里剔除"
                                : scoreRow
                                  ? `判断 ${scoreRow.read} · 表达 ${scoreRow.voice} · 操作 ${scoreRow.craft} · 抗压 ${scoreRow.poise}`
                                  : "这一席没给该座位打分"
                          }
                          className={`mono border-b border-line/60 px-2 py-1.5 text-right ${
                            value === null || self || dropped ? "text-fg-faint" : "text-fg-dim"
                          } ${self ? "bg-ink-2/50" : ""}`}
                        >
                          {value === null ? "—" : value.toFixed(1)}
                          {dropped && <sup className="ml-0.5 text-[8px]">剔</sup>}
                        </td>
                      );
                    })}
                  </tr>
                  {expanded && ok && (
                    <tr>
                      <td colSpan={seats.length + 1} className="border-b border-line/60 bg-ink-1/40 px-2 py-2">
                        {ok.summary && (
                          <p className="text-[12px] leading-relaxed text-fg-dim">{ok.summary}</p>
                        )}
                        {chars > 0 && (
                          <details className="mt-2 rounded border border-line/60 bg-ink-1/40 px-2 py-1.5">
                            <summary className="cursor-pointer text-[11px] text-fg-faint">
                              当时的推演 · {charCount(chars)}（只保留尾部）
                            </summary>
                            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg-faint">
                              {cleanNative(stream?.reason || stream?.note || "")}
                            </p>
                          </details>
                        )}
                        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                          {seats.map((seat) => {
                            const scoreRow = ballotRow(ok, seat.seat);
                            const model = seatModel(seats, seat.seat);
                            return (
                              <div
                                key={seat.seat}
                                className="rounded border border-line/70 bg-ink-1/60 px-2 py-1.5"
                              >
                                <div className="flex items-baseline gap-1.5">
                                  <span className="mono text-[11px] text-fg">{seat.seat + 1}号</span>
                                  <span className="text-[10px] text-fg-faint">
                                    {roleName(seats, seat.seat)}
                                  </span>
                                  {model && (
                                    <span
                                      className="mono ml-auto min-w-0 truncate text-[10px] text-fg-dim"
                                      title={seatModelTitle(seats, seat.seat)}
                                    >
                                      {model}
                                    </span>
                                  )}
                                </div>
                                {scoreRow ? (
                                  <div className="mono mt-0.5 text-[10px] text-fg-dim">
                                    判断 {scoreRow.read} · 表达 {scoreRow.voice} · 操作{" "}
                                    {scoreRow.craft} · 抗压 {scoreRow.poise}
                                  </div>
                                ) : (
                                  <div className="mono mt-0.5 text-[10px] text-fg-faint">未打分</div>
                                )}
                                {scoreRow?.comment && (
                                  <p className="mt-0.5 text-[11px] leading-relaxed text-fg-faint">
                                    {scoreRow.comment}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-[11px] text-fg-faint">
          <span className="label">被剔除的极值票</span>
          {!review.rubric?.trim ? (
            <span>评分标准未开启去极值，每张同行票都计入。</span>
          ) : droppedRows.length === 0 ? (
            <span>没有座位触发去极值（同行票需要 ≥ 6 张）。</span>
          ) : (
            droppedRows.map((row) => (
              <span key={row.seat} className="mono text-fg-dim">
                {row.seat + 1}号 ← {row.dropped.map((r) => `${r + 1}号`).join("、")}
              </span>
            ))
          )}
          <span className="ml-auto text-fg-faint">上标「剔」= 已剔除的极值票 · 浅底 = 自评票</span>
        </div>
      </div>
    </details>
  );
}

/* ── rubric ────────────────────────────────────────────────────────── */

function RubricPanel({
  rubric,
  weights,
  judgeExpected,
}: {
  rubric: ReviewRubric;
  weights: ReturnType<typeof reviewWeights>;
  judgeExpected: boolean;
}) {
  return (
    <div className="mt-3 space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[12px]">
          <thead>
            <tr className="text-[10px] text-fg-faint">
              <th className="w-20 border-b border-line px-2 py-2 text-left font-normal">维度</th>
              <th className="w-16 border-b border-line px-2 py-2 text-right font-normal">权重</th>
              <th className="border-b border-line px-2 py-2 text-left font-normal">看什么</th>
            </tr>
          </thead>
          <tbody>
            {REVIEW_DIMENSION_COPY.map((dim) => (
              <tr key={dim.key}>
                <td className="border-b border-line/60 px-2 py-2 align-top">
                  <span className="text-fg">{dim.label}</span>
                  <span className="mono ml-1 text-[10px] text-fg-faint">{dim.key}</span>
                </td>
                <td className="mono border-b border-line/60 px-2 py-2 text-right align-top text-jade">
                  {pct(weights[dim.key])}
                </td>
                <td className="border-b border-line/60 px-2 py-2 align-top">
                  <p className="text-fg-dim">{dim.hint}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">{dim.anchor}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <RuleCell title="自评政策">
          {rubric.selfWeight > 0
            ? `自评票按 ${pct(rubric.selfWeight)} 的权重计入自己的均值。`
            : "自评票只展示，不计入总分；自己给自己打多少都不影响名次。"}
        </RuleCell>
        <RuleCell title="裁判票">
          {judgeExpected
            ? `裁判一票按 ${rubric.judgeVotes} 张玩家票计入均值；裁判也可以由桌上某个模型兼任，座位票与裁判票分开计入。`
            : "这一局没有裁判票，9 个座位互评。"}
        </RuleCell>
        <RuleCell title="去极值">
          {rubric.trim
            ? "每个座位至少有 6 张同行票时，剔掉一张最高、一张最低再取均值；被剔的票在评委明细里标「剔」。"
            : "不去极值：每张同行票都计入均值。"}
        </RuleCell>
        <RuleCell title="样本不足">
          {`有效玩家票少于 ${rubric.minBallots} 张时，结论标为「非正式」，只作参考。`}
        </RuleCell>
      </div>

      <p className="text-[11px] leading-relaxed text-fg-faint">
        评委只看到公开记录与终局翻牌：模型名、接入方、队名一律不进 prompt；
        评分是独立的一轮调用，不回写对局事件。
      </p>
    </div>
  );
}

function RuleCell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-ink-1/50 px-3 py-2">
      <div className="label">{title}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-fg-dim">{children}</p>
    </div>
  );
}
