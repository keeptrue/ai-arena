"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEATH_LABEL,
  PHASE_CHIP,
  ROLE_LABEL,
  THOUGHT_LABEL,
  buildFrames,
  cleanNative,
  cleanThinking,
  currentFrameId,
  decisionRounds,
  frameSpeeches,
  frameThoughts,
  kindLabel,
  logText,
  reasonLabel,
  seatActionFor,
  seatBallot,
  seatCardMid,
  seatStatus,
  type DecisionRound,
  type Frame,
  type TableAction,
  type TableState,
  type TableThought,
} from "@/lib/werewolf-frame";

function seatPoint(seat: number, radius: number): { x: number; y: number } {
  const angle = ((-90 + seat * 40) * Math.PI) / 180;
  return { x: 60 + Math.cos(angle) * radius, y: 60 + Math.sin(angle) * radius };
}

function SeatRing({
  frame,
  view,
  godView,
  revealed,
}: {
  frame: Frame;
  view: TableState;
  godView: boolean;
  revealed: boolean;
}) {
  const showRole = godView || revealed;
  const vote = frame.vote;
  return (
    <svg viewBox="0 0 120 120" className="ww-reel-ring" aria-hidden>
      <circle cx="60" cy="60" r="50" className="text-line" stroke="currentColor" fill="none" strokeWidth="1" />
      <circle
        cx="60"
        cy="60"
        r="39"
        className="text-line"
        stroke="currentColor"
        fill="none"
        strokeWidth="1"
        strokeDasharray="2 4"
      />
      {vote
        ? Object.entries(vote.votes).map(([from, to]) => {
            if (typeof to !== "number") return null;
            const a = seatPoint(Number(from), 39);
            const b = seatPoint(to, 39);
            return (
              <path
                key={`v-${from}-${to}`}
                d={`M${a.x} ${a.y} Q60 60 ${b.x} ${b.y}`}
                className="text-blood"
                stroke="currentColor"
                strokeWidth="0.9"
                fill="none"
                opacity="0.45"
              />
            );
          })
        : null}
      {view.seats.map((seat) => {
        const p = seatPoint(seat.seat, 39);
        const dead = frame.deaths.includes(seat.seat);
        const spoke = frame.speeches.includes(seat.seat);
        const camp = seat.role === "wolf" ? "wolf" : seat.role === "seer" || seat.role === "witch" || seat.role === "hunter" ? "god" : "good";
        const color = showRole ? (camp === "wolf" ? "text-blood" : camp === "god" ? "text-amber" : "text-ghost") : "text-fg-dim";
        return (
          <g key={seat.seat} className={dead ? "text-blood" : color}>
            {spoke ? (
              <circle cx={p.x} cy={p.y} r="8" className="text-jade" stroke="currentColor" fill="none" strokeWidth="0.8" opacity="0.6" />
            ) : null}
            <circle cx={p.x} cy={p.y} r="5.5" fill="var(--color-ink-1)" stroke="currentColor" strokeWidth="1.1" />
            <text
              x={p.x}
              y={p.y + 2.4}
              textAnchor="middle"
              fontSize="5.5"
              fill="currentColor"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {seat.seat + 1}
            </text>
            {dead ? (
              <>
                <line x1={p.x - 7} y1={p.y - 7} x2={p.x + 7} y2={p.y + 7} stroke="currentColor" strokeWidth="1" />
                <line x1={p.x + 7} y1={p.y - 7} x2={p.x - 7} y2={p.y + 7} stroke="currentColor" strokeWidth="1" />
              </>
            ) : null}
          </g>
        );
      })}
      <text x="60" y="58" textAnchor="middle" className="text-fg" fill="currentColor" style={{ fontFamily: "var(--font-serif)", fontSize: 10 }}>
        {frame.label}
      </text>
      <text x="60" y="68" textAnchor="middle" className="text-fg-faint" fill="currentColor" style={{ fontFamily: "var(--font-mono)", fontSize: 4.5 }}>
        {frame.kind === "end" ? "FINAL" : `DAY ${frame.day}`}
      </text>
    </svg>
  );
}

function Roster({
  view,
  frame,
  currentId,
  godView,
  revealed,
  selectedSeat,
  onSelect,
}: {
  view: TableState;
  frame: Frame;
  currentId: string;
  godView: boolean;
  revealed: boolean;
  selectedSeat: number;
  onSelect: (seat: number) => void;
}) {
  const showRole = godView || revealed;
  return (
    <aside className="ww-reel-roster" aria-label="本帧九席状态">
      <div className="ww-reel-roster-head">
        <h2>本帧九席</h2>
        <span className="ww-reel-roster-sub">{frame.caption}</span>
      </div>
      <div className="ww-reel-legend">
        <span className="l-jade">发言中</span>
        <span className="l-amber">推演中</span>
        <span className="l-blue">已投票</span>
        <span className="l-red">出局</span>
      </div>
      <div className="ww-reel-cards">
        {view.seats.map((seat) => {
          const status = seatStatus(view, frame, seat, currentId, showRole);
          const dead = frame.deaths.includes(seat.seat);
          const act = seatActionFor(view, frame, seat.seat);
          const frameSpeechItem = frame.items.find(
            (i) => i.kind === "speech" && i.seat === seat.seat,
          );
          const lastWords =
            frame.items.find((i) => i.kind === "last_words" && i.seat === seat.seat) ??
            (frame.kind === "end"
              ? view.publicLog.filter((i) => i.kind === "last_words" && i.seat === seat.seat).at(-1) ?? null
              : null);
          const thoughts = frameThoughts(view, frame, seat.seat);
          const liveNote = frame.id === currentId ? seat.thinking.length : 0;
          const liveNative = frame.id === currentId ? seat.reasoning.length : 0;
          const noteLen = showRole
            ? Math.max(
                thoughts.reduce((n, t) => n + t.text.length, 0),
                liveNote,
              )
            : 0;
          const nativeLen = showRole
            ? Math.max(
                thoughts.reduce((n, t) => n + t.native.length, 0),
                liveNative,
              )
            : 0;
          const liveVote = frame.id === currentId && showRole ? seat.vote : null;
          const vote = frame.vote?.votes[seat.seat] ?? liveVote;
          const count = frame.vote?.counts[seat.seat] ?? 0;
          const camp = showRole ? seat.camp ?? "" : "";
          const mid = seatCardMid({
            dead,
            death: seat.death?.cause,
            showRole,
            vote,
          });
          const spoken = [
            frameSpeechItem ? { label: "发言", len: logText(frameSpeechItem).length } : null,
            lastWords ? { label: "遗言", len: logText(lastWords).length } : null,
          ].filter((f): f is { label: string; len: number } => f !== null);
          const foot = spoken.length
            ? spoken
            : dead && seat.lastSpeech
              ? [{ label: "生前发言", len: seat.lastSpeech.length }]
              : frame.kind === "end" && seat.lastSpeech
                ? [{ label: "最后发言", len: seat.lastSpeech.length }]
                : [];
          const fresh = frame.id === currentId && seat.status === "ready";
          return (
            <button
              key={seat.seat}
              type="button"
              className="ww-reel-pcard"
              data-camp={camp}
              data-dead={dead}
              data-speaking={status.label === "发言中" || status.label === "遗言中"}
              data-selected={selectedSeat === seat.seat}
              data-fresh={fresh}
              onClick={() => onSelect(seat.seat)}
            >
              <span className="ww-reel-pcard-top">
                <span className="ww-reel-pcard-num">{String(seat.seat + 1).padStart(2, "0")}</span>
                <span className="ww-reel-pcard-role">{showRole && seat.role ? ROLE_LABEL[seat.role] : "未知"}</span>
                <span className="ww-reel-pcard-stat" data-tone={status.tone}>
                  {status.label}
                </span>
              </span>
              <span className="ww-reel-pcard-name">{seat.display}</span>
              {act && showRole ? (
                <span className="ww-reel-pcard-act" data-tone={act.tone} title={act.detail || act.label}>
                  {act.label}
                </span>
              ) : null}
              <span className="ww-reel-pcard-mid">
                <span className="v">{mid}</span>
                {count > 0 ? <span className="n">{count}票</span> : null}
              </span>
              <span className="ww-reel-pcard-foot">
                <span>
                  {foot.length > 0 ? (
                    <>
                      {foot.map((f, i) => (
                        <span key={`${f.label}-${i}`}>
                          {i > 0 ? " · " : ""}
                          {f.label} <b>{f.len}</b>
                        </span>
                      ))}
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                <span>
                  {noteLen > 0 ? (
                    <>
                      旁白 <b>{noteLen.toLocaleString()}</b>
                    </>
                  ) : nativeLen > 0 ? (
                    <>
                      推理 <b>{nativeLen.toLocaleString()}</b>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </span>
              {dead && showRole && seat.death?.cause ? (
                <span className="ww-reel-pcard-out">{DEATH_LABEL[seat.death.cause]}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** The seat's action, rendered on its own so it can never be mistaken for a speech. */
function ActionBlock({ action }: { action: TableAction }) {
  return (
    <div className="ww-reel-block ww-reel-block--action">
      <div className="label">行动 · {action.tag}</div>
      <div className="ww-reel-action-line" data-tone={action.tone}>
        <span className="ww-reel-action-label">{action.label}</span>
        {action.detail && action.kind !== "wolf" ? (
          <span className="ww-reel-action-detail">
            {action.kind === "seer" ? "→ " : ""}
            {action.detail}
          </span>
        ) : null}
      </div>
      {action.kind === "wolf" && action.detail ? (
        <p className="ww-reel-action-talk">「{action.detail}」</p>
      ) : null}
    </div>
  );
}

const DECISION_STATE_LABEL = {
  thinking: "推演中",
  ready: "已提交",
  forfeit: "弃权",
  waiting: "待定",
} as const;

/**
 * The decision wall: every seat's move and the note it left, side by side.
 *
 * During a vote all nine seats think at once, so a single-seat aside can only ever
 * show one of them. This board is the room: nine cards, nine half-finished
 * sentences, and the vote each one settled on.
 */
function DecisionBoard({
  view,
  rounds,
  showPrivate,
  selectedSeat,
  onSelect,
}: {
  view: TableState;
  rounds: DecisionRound[];
  showPrivate: boolean;
  selectedSeat: number;
  onSelect: (seat: number) => void;
}) {
  if (!showPrivate || rounds.length === 0) return null;
  return (
    <section className="ww-reel-decisions" aria-label="抉择旁白">
      <header className="ww-reel-decisions-head">
        <span className="label">抉择旁白</span>
        <span className="mono">只给观众 · 对手与裁判不可见</span>
      </header>
      {rounds.map((round) => {
        const isVote = round.phase === "day_vote" || round.phase === "day_pk_vote";
        const done = round.rows.filter((r) => r.status === "ready" || r.status === "forfeit").length;
        return (
          <div key={round.phase} className="ww-reel-decision-round">
            <div className="ww-reel-decision-round-head">
              <span className="label">{round.label}</span>
              <span className="mono">
                {isVote ? `已投 ${done}/${round.rows.length}` : `已动 ${done}`}
              </span>
            </div>
            <div className="ww-reel-decision-grid">
              {round.rows.map((row) => {
                const seat = view.seats[row.seat];
                const note = cleanThinking(row.note);
                const native = cleanNative(row.native);
                const empty = !note;
                return (
                  <button
                    key={`${round.phase}-${row.seat}`}
                    type="button"
                    className="ww-reel-dcard"
                    data-selected={selectedSeat === row.seat}
                    data-live={row.status === "thinking"}
                    data-empty={empty}
                    onClick={() => onSelect(row.seat)}
                  >
                    <span className="ww-reel-dcard-top">
                      <span className="ww-reel-dcard-num">
                        {String(row.seat + 1).padStart(2, "0")}
                      </span>
                      <span className="ww-reel-dcard-name">{seat?.display ?? `${row.seat + 1}号`}</span>
                      <span className="ww-reel-dcard-state" data-tone={row.status}>
                        {DECISION_STATE_LABEL[row.status]}
                      </span>
                    </span>
                    <span className="ww-reel-dcard-line" data-tone={row.status}>
                      {row.status === "ready"
                        ? row.label
                        : row.status === "forfeit"
                          ? "弃权"
                          : row.status === "thinking"
                            ? "正在权衡…"
                            : "还没动"}
                    </span>
                    <span className="ww-reel-dcard-note" data-empty={empty}>
                      {empty
                        ? row.status === "waiting"
                          ? "还在听桌上的动静。"
                          : "这一手没有留下旁白。"
                        : note.slice(0, 240)}
                    </span>
                    <span className="ww-reel-dcard-foot mono">
                      {note ? `旁白 ${note.length.toLocaleString()} 字` : ""}
                      {native ? `${note ? " · " : ""}推理 ${native.length.toLocaleString()} 字` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function WerewolfReel({
  view,
  godView,
  revealed,
}: {
  view: TableState;
  godView: boolean;
  revealed: boolean;
}) {
  const reveal = godView || revealed;
  const frames = useMemo(() => buildFrames(view, reveal), [view, reveal]);
  const [frameId, setFrameId] = useState<string>(() => currentFrameId(view));
  const [pinned, setPinned] = useState(false);
  const [selectedSeat, setSelectedSeat] = useState(0);
  const [tab, setTab] = useState<"aside" | "god">("aside");
  const [endSeat, setEndSeat] = useState<number | null>(null);
  const [openSpeech, setOpenSpeech] = useState<string | null>(null);
  const [openThought, setOpenThought] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const current = frames.find((f) => f.id === frameId) ?? frames[0];
  const currentId = currentFrameId(view);
  const seat = view.seats[selectedSeat] ?? view.seats[0] ?? null;
  const speeches = current && seat
    ? current.kind === "end"
      ? view.publicLog.filter((i) => i.seat === seat.seat && i.kind === "speech").slice(-1)
      : frameSpeeches(view, current, seat.seat)
    : [];
  const archivedThoughts = current && seat ? frameThoughts(view, current, seat.seat) : [];
  const liveThought: TableThought | null =
    current?.id === currentId &&
    seat &&
    seat.status === "thinking" &&
    (seat.thinking || seat.reasoning) &&
    !archivedThoughts.some((t) => t.phase === view.phase)
      ? { day: view.day, phase: view.phase, seat: seat.seat, text: seat.thinking, native: seat.reasoning }
      : null;
  const thoughts = liveThought ? [...archivedThoughts, liveThought] : archivedThoughts;
  const endThought =
    current?.kind === "end" && seat && thoughts.length === 0
      ? view.thinkingHistory.filter((t) => t.seat === seat.seat).at(-1) ?? null
      : null;
  const thoughtList = endThought ? [endThought] : thoughts;
  const hasThought = thoughtList.some((t) => cleanThinking(t.text) || cleanNative(t.native));
  const rounds = useMemo(
    () => (current ? decisionRounds(view, current) : []),
    [view, current],
  );
  const action = current && seat ? seatActionFor(view, current, seat.seat) : null;
  // A dead process has no seats thinking: the last delta only froze the chip there.
  const thinkingSeats = view.live
    ? view.seats.filter((s) => s.status === "thinking").map((s) => s.seat)
    : [];
  const liveRound = current?.id === currentId ? rounds.find((r) => r.phase === view.phase) : undefined;
  const liveDone = liveRound
    ? liveRound.rows.filter((r) => r.status === "ready" || r.status === "forfeit").length
    : 0;

  useEffect(() => {
    if (pinned) return;
    const id = currentFrameId(view);
    setFrameId(id);
  }, [view, pinned]);

  useEffect(() => {
    if (!current) return;
    const last = current.items.filter((i) => i.seat != null).at(-1);
    if (last?.seat != null) setSelectedSeat(last.seat);
    setOpenSpeech(null);
    setOpenThought(null);
    setOpenRow(null);
    setEndSeat(null);
  }, [current?.id]);

  useEffect(() => {
    // Scroll the filmstrip itself; scrollIntoView would drag the whole page on first paint.
    const strip = stripRef.current;
    const node = strip?.querySelector<HTMLElement>(`[data-frame="${frameId}"]`);
    if (!strip || !node) return;
    const align = () => {
      const box = strip.getBoundingClientRect();
      const card = node.getBoundingClientRect();
      const pad = 8;
      if (card.top < box.top + pad) strip.scrollTop += card.top - box.top - pad;
      else if (card.bottom > box.bottom - pad) strip.scrollTop += card.bottom - box.bottom + pad;
      if (card.left < box.left + pad) strip.scrollLeft += card.left - box.left - pad;
      else if (card.right > box.right - pad) strip.scrollLeft += card.right - box.right + pad;
    };
    align();
    // Re-align when the rail or the active card changes size (fonts, ring, viewport).
    const observer = new ResizeObserver(align);
    observer.observe(strip);
    observer.observe(node);
    const timer = window.setTimeout(align, 120);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [frameId, frames.length]);

  if (!current) {
    return <div className="panel p-6 text-[12px] text-fg-faint">还没有可放映的记录。</div>;
  }
  if (!seat) return <div className="panel p-6 text-[12px] text-fg-faint">这一桌还没有座位。</div>;
  const showPrivate = godView || revealed;
  const alive = view.seats.filter((s) => s.alive).length;
  const isCurrent = current.id === currentId;
  const frameVote = current.vote;
  // A settled tally is public; a live ballot is only visible in god view.
  const asideVote = frameVote?.votes[seat.seat] ?? (isCurrent && showPrivate ? seat.vote : null);

  return (
    <div className="ww-reel">
      <aside className="ww-reel-rail" aria-label="夜与天胶片">
        <div className="ww-reel-rail-head">
          <span className="label">胶片</span>
          <span className="mono">{frames.length} 帧</span>
          {pinned ? (
            <button
              type="button"
              onClick={() => {
                setPinned(false);
                setFrameId(currentId);
              }}
            >
              回到当前
            </button>
          ) : null}
        </div>
        <div className="ww-reel-strip" ref={stripRef}>
          {frames.map((f) => (
            <button
              key={f.id}
              type="button"
              className="ww-reel-frame"
              data-active={f.id === current.id}
              data-live={f.id === currentId}
              data-frame={f.id}
              onClick={() => {
                setPinned(true);
                setFrameId(f.id);
                setTab("aside");
              }}
            >
              <div className="ww-reel-frame-top">
                <span className="mono">{f.no} · {f.label}</span>
                <span className="ww-reel-frame-sub">{f.sub}</span>
              </div>
              <h2>{f.title}</h2>
              <div className="ww-reel-ring-wrap">
                <SeatRing frame={f} view={view} godView={godView} revealed={revealed} />
              </div>
              <div className="ww-reel-caption" title={f.caption}>
                {f.caption}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="ww-reel-lower">
        <section className="ww-reel-scene">
          <header className="ww-reel-scene-head">
            <div className="label">
              {current.label} · {isCurrent ? "当前帧" : "回放"}
            </div>
            <div className="ww-reel-scene-meta">
              <span className="mono">存活 {alive}/9</span>
              {isCurrent && liveRound ? (
                <span className="ww-reel-livecount mono">
                  {liveRound.phase === "day_vote" || liveRound.phase === "day_pk_vote"
                    ? `已投 ${liveDone}/${liveRound.rows.length}`
                    : `已动 ${liveDone}`}
                </span>
              ) : (
                <span>{current.items.length} 条记录</span>
              )}
              {isCurrent && !view.live && !view.finished ? (
                <span className="ww-reel-follow" data-static="true">
                  ● 已中断
                </span>
              ) : isCurrent && thinkingSeats.length === 1 ? (
                <button
                  type="button"
                  className="ww-reel-follow"
                  onClick={() => setSelectedSeat(thinkingSeats[0])}
                >
                  ● {thinkingSeats[0] + 1}号推演中
                </button>
              ) : isCurrent && thinkingSeats.length > 1 ? (
                <span className="ww-reel-follow" data-static="true">
                  ● {thinkingSeats.length} 席推演中
                </span>
              ) : null}
            </div>
          </header>

          {isCurrent && liveRound ? (
            <DecisionBoard
              view={view}
              rounds={rounds}
              showPrivate={showPrivate}
              selectedSeat={seat.seat}
              onSelect={(n) => {
                setSelectedSeat(n);
                setTab("aside");
                setOpenThought(null);
              }}
            />
          ) : null}

          <div className="ww-reel-rows">
            {current.items.length === 0 ? (
              <p className="ww-reel-empty">
                {current.kind === "night" ? "这一夜还没有公开记录。天亮了再看。" : "这一帧还没有记录。"}
              </p>
            ) : null}
            {current.items.map((item) => {
              const s = item.seat != null ? view.seats[item.seat] : null;
              const open = openRow === `${item.seq}-${item.kind}`;
              const text = logText(item);
              return (
                <div
                  key={`${item.seq}-${item.kind}`}
                  className="ww-reel-row"
                  data-kind={item.kind}
                  data-tone={item.tone}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (item.seat != null) {
                      setSelectedSeat(item.seat);
                      setTab("aside");
                      setOpenSpeech(null);
                      setOpenThought(null);
                    } else {
                      setOpenRow(open ? null : `${item.seq}-${item.kind}`);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (item.seat != null) {
                        setSelectedSeat(item.seat);
                        setTab("aside");
                      } else setOpenRow(open ? null : `${item.seq}-${item.kind}`);
                    }
                  }}
                >
                  <div className="ww-reel-row-n">
                    <span className="mono">{s ? String(s.seat + 1).padStart(2, "0") : "—"}</span>
                    <small>{kindLabel(item)}</small>
                  </div>
                  <div className="ww-reel-row-body">
                    <p className={open ? "ww-reel-row-full" : "line-clamp-2"}>{text}</p>
                  </div>
                  <div className="ww-reel-row-meta">
                    {s ? <span>{s.display}</span> : null}
                    {item.kind === "speech" ? <span className="mono">{text.length} 字</span> : null}
                    {s && showPrivate && s.role ? <span>{ROLE_LABEL[s.role]}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>

          {frameVote ? (
            <div className="ww-reel-votes">
              <span className="label">票型</span>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(frameVote.votes)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([from, to]) => (
                    <span key={from} className="ww-reel-ballot" data-exiled={Number(to) === frameVote.exiled}>
                      {Number(from) + 1}→{to === "abstain" ? "弃" : `${Number(to) + 1}`}
                    </span>
                  ))}
              </div>
            </div>
          ) : null}

          {!isCurrent || !liveRound ? (
            <DecisionBoard
              view={view}
              rounds={rounds}
              showPrivate={showPrivate}
              selectedSeat={seat.seat}
              onSelect={(n) => {
                setSelectedSeat(n);
                setTab("aside");
                setOpenThought(null);
              }}
            />
          ) : null}
        </section>

        <aside className="ww-reel-aside">
          <div className="ww-reel-now">
            <strong>{current.title}</strong>
            <span className="mono">
              {current.label} · {isCurrent ? "当前帧" : "回放"}
            </span>
          </div>
          <div className="ww-reel-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "aside"}
              onClick={() => setTab("aside")}
            >
              旁白
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "god"}
              disabled={!godView}
              onClick={() => setTab("god")}
            >
              神视
            </button>
          </div>

          {tab === "god" ? (
            <div className="ww-reel-aside-body">
              {!godView ? (
                <p className="ww-reel-empty">上帝视角已关闭。</p>
              ) : current.godItems.length === 0 ? (
                <p className="ww-reel-empty">这一帧没有夜间记录。</p>
              ) : (
                current.godItems.map((item) => (
                  <div key={`${item.seq}-${item.kind}`} className="ww-reel-god-row">
                    <span className="mono">D{item.day}</span>
                    <p>{item.text}</p>
                  </div>
                ))
              )}
            </div>
          ) : current.kind === "end" && endSeat === null ? (
            <div className="ww-reel-aside-body">
              <div className="ww-reel-seat-head">
                <div>
                  <div className="label">FINAL · 终局</div>
                  <h3>{view.winner?.name ? `${view.winner.name}胜` : "无胜者"}</h3>
                  <p>
                    {reasonLabel(view.winner?.reason ?? "")} · 第 {view.day} 天
                  </p>
                </div>
              </div>
              <div className="ww-reel-block">
                <div className="label">终局翻牌</div>
                <div className="ww-reel-roles">
                  {view.seats.map((s) => (
                    <span
                      key={s.seat}
                      className={`ww-reel-role ${
                        s.role === "wolf" ? "text-blood" : s.role === "villager" ? "text-fg-dim" : "text-amber"
                      }`}
                    >
                      {s.seat + 1}号 {s.role ? ROLE_LABEL[s.role] : "?"}
                    </span>
                  ))}
                </div>
              </div>
              <div className="ww-reel-block">
                <div className="label">存活</div>
                <p className="ww-reel-prose">
                  {view.seats.filter((s) => s.alive).map((s) => `${s.seat + 1}号`).join("、") || "无人"}
                </p>
              </div>
            </div>
          ) : (
            <div className="ww-reel-aside-body">
              <div className="ww-reel-seat-head">
                <div>
                  <div className="label">SEAT {String(seat.seat + 1).padStart(2, "0")}</div>
                  <h3>{seat.seat + 1}号 · {seat.display}</h3>
                  <p className="mono">
                    {seat.alive ? "存活" : `出局${showPrivate && seat.death?.cause ? ` · ${DEATH_LABEL[seat.death.cause]}` : ""}`}
                    {showPrivate && seat.role ? ` · ${ROLE_LABEL[seat.role]}` : ""}
                    {asideVote != null ? ` · ${seatBallot(asideVote)}` : ""}
                  </p>
                </div>
                <div className="ww-reel-seat-nav">
                  {current.kind === "end" ? (
                    <button type="button" className="ww-reel-summary" onClick={() => setEndSeat(null)}>
                      摘要
                    </button>
                  ) : null}
                  <button type="button" onClick={() => setSelectedSeat((s) => (s + 8) % 9)} aria-label="上一位">
                    ←
                  </button>
                  <button type="button" onClick={() => setSelectedSeat((s) => (s + 1) % 9)} aria-label="下一位">
                    →
                  </button>
                </div>
              </div>

              {showPrivate && action ? <ActionBlock action={action} /> : null}

              {speeches.length ? (
                speeches.map((sp) => {
                  const key = `${sp.seq}-${sp.kind}`;
                  const open = openSpeech === key;
                  const text = logText(sp);
                  const label =
                    sp.kind === "last_words"
                      ? "遗言 · 已出局"
                      : sp.phase === "day_pk_speech"
                        ? "PK 发言"
                        : "本帧发言";
                  return (
                    <div key={key} className="ww-reel-block ww-reel-block--speech">
                      <div className="label">{label}</div>
                      <p className={open ? "ww-reel-prose" : "ww-reel-prose line-clamp-6"}>{text}</p>
                      <div className="ww-reel-block-foot">
                        <span className="mono">{text.length} 字</span>
                        <button type="button" onClick={() => setOpenSpeech(open ? null : key)}>
                          {open ? "收起" : "读全文"}
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="ww-reel-empty">这一席在本帧没有发言。</p>
              )}

              {showPrivate
                ? thoughtList.map((t) => {
                    const key = `${t.day}-${t.phase}`;
                    const note = cleanThinking(t.text);
                    const native = cleanNative(t.native);
                    if (!note && !native) return null;
                    const open = openThought === key;
                    return (
                      <div key={key} className="ww-reel-block ww-reel-block--note">
                        <div className="label">
                          {THOUGHT_LABEL[t.phase] ?? "旁白"} · {note ? "写给观众" : "仅原始推理"}
                          {liveThought?.phase === t.phase ? (
                            <span className="ww-reel-live-dot" aria-label="正在推演">
                              ●
                            </span>
                          ) : null}
                        </div>
                        {!note ? (
                          <p className="ww-reel-thought-meta mono">
                            这一手模型没有输出写给观众的旁白，下面是它的原始推理。
                          </p>
                        ) : null}
                        {note ? (
                          <>
                            <div className="ww-reel-thought-meta mono">
                              原文 {t.text.length.toLocaleString()} 字 · 可读 {note.length.toLocaleString()} 字
                              {open ? "" : ` · 预览 ${Math.min(1200, note.length).toLocaleString()} 字`}
                            </div>
                            <p className={open ? "ww-reel-prose" : "ww-reel-prose line-clamp-8"}>
                              {open ? note.slice(0, 20000) : note.slice(0, 1200)}
                            </p>
                            {note.length > 1200 ? (
                              <div className="ww-reel-block-foot">
                                <span className="mono">
                                  {open && note.length > 20000 ? "已截断至 20,000 字" : ""}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setOpenThought(open ? null : key)}
                                >
                                  {open ? "收起" : "展开全文"}
                                </button>
                              </div>
                            ) : null}
                          </>
                        ) : null}
                        {native ? (
                          <details
                            className="ww-reel-block ww-reel-block--raw"
                            open={!note && native.length <= 2000}
                          >
                            <summary>
                              原始推理 · 模型内部 · {native.length.toLocaleString()} 字
                            </summary>
                            <p className="ww-reel-prose">{native.slice(0, 20000)}</p>
                            {native.length > 20000 ? (
                              <p className="ww-reel-thought-meta mono">已截断至 20,000 字</p>
                            ) : null}
                          </details>
                        ) : null}
                      </div>
                    );
                  })
                : null}

              {!showPrivate ? (
                <p className="ww-reel-empty">玩家视角：底牌、夜间行动与思考已隐藏。</p>
              ) : !hasThought ? (
                <p className="ww-reel-empty">这一席在本帧没有留下旁白。</p>
              ) : null}
            </div>
          )}
        </aside>
      </div>

      <Roster
        view={view}
        frame={current}
        currentId={currentId}
        godView={godView}
        revealed={revealed}
        selectedSeat={seat.seat}
        onSelect={(n) => {
          setSelectedSeat(n);
          setEndSeat(n);
          setTab("aside");
          setOpenSpeech(null);
          setOpenThought(null);
        }}
      />
    </div>
  );
}
