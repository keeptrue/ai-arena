"use client";

/**
 * Coup table. Consumes the event stream only — no business requests, no writes.
 * The audience sees every hand; the models never do.
 *
 * Reading order is chosen for someone who has never played Coup:
 *   1. who is acting, on whom, with what   (the table + the turn tab)
 *   2. what was said and how the table answered
 *   3. what it cost, and what happens next
 *
 * Every affordance here does something: a seat opens its dossier, a timeline
 * card pins that turn into the right-hand panel, a header number explains
 * itself. Nothing is `cursor-pointer` for decoration.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArenaEvent } from "@/engine/types";
import {
  describeTurn,
  describeTurnSteps,
  type CoupTurnRecord,
  type CoupTurnStep,
} from "@/engine/coup/turn";
import {
  COUP_ACTION_EFFECT,
  COUP_ACTION_LABEL,
  COUP_REACTION_LABEL,
  COUP_ROLE_GLYPH,
  COUP_ROLE_LABEL,
  applyCoupEvent,
  bluffCount,
  emptyCoupFrame,
  phaseText,
  replayCoup,
  type CoupFrame,
  type CoupFrameSeat,
} from "@/lib/coup-frame";
import { publishPin } from "@/lib/pin";
import { ThinkingBody } from "./arena-blocks";

interface Props {
  matchId: string;
}

const POS = ["s", "w", "n", "e"];
const DEFAULT_TURNS = 60;

const ACTION_ROWS: Array<[string, string, boolean, boolean, string]> = [
  ["收入", "拿 1 枚", false, false, "—"],
  ["外援", "拿 2 枚", false, true, "公爵 · 任何玩家"],
  ["政变", "付 7 枚，取一条命", false, false, "—"],
  ["征税", "拿 3 枚", true, false, "—"],
  ["刺杀", "付 3 枚，取一条命", true, true, "伯爵夫人 · 仅目标"],
  ["偷窃", "拿 2 枚", true, true, "队长 / 大使 · 仅目标"],
  ["换牌", "抽 2 张，换 2 张", true, false, "—"],
];

const STEPS: Array<[string, string]> = [
  ["宣称", "角色行动等于宣称持有该身份，不必亮牌，可以说谎。"],
  ["质疑", "任何其他玩家可发起，只认第一个开口的人。"],
  ["结质疑", "亮得出：质疑者掉命；亮不出：行动作废、退钱、行动者掉命。"],
  ["阻挡", "外援任何人可挡；刺杀、偷窃只有目标能挡。"],
  ["结阻挡", "阻挡者亮不出：阻挡失效、行动生效；亮得出：行动被挡下。"],
  ["结算", "金币易手、目标翻牌，顺时针交给下一位。"],
];

type Tab = "turn" | "dossier" | "chronicle";
type HeadKey = "turns" | "deck" | "alive" | null;

export function CoupTable({ matchId }: Props) {
  const [frame, setFrame] = useState<CoupFrame>(() => emptyCoupFrame(matchId));
  const [live, setLive] = useState(true);
  const [resumable, setResumable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [totalTurns, setTotalTurns] = useState(DEFAULT_TURNS);
  const [tab, setTab] = useState<Tab>("turn");
  const [pinned, setPinned] = useState<number | null>(null);
  const [openSeat, setOpenSeat] = useState<number | null>(null);
  const [head, setHead] = useState<HeadKey>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    const boot = async () => {
      const res = await fetch(`/api/matches/${matchId}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        match: { status: string; blueprint_snapshot_json: string };
        roster: { participants: Array<{ seat: number; model: { display: string } }> };
        events: ArenaEvent[];
        live: boolean;
        resumable: boolean;
      };
      if (cancelled) return;
      const spec = safeParse(data.match.blueprint_snapshot_json);
      const base = emptyCoupFrame(matchId);
      base.name = typeof spec?.name === "string" ? spec.name : base.name;
      if (typeof spec?.rules?.maxTurns === "number") setTotalTurns(spec.rules.maxTurns);
      base.seats = data.roster.participants
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          seat: p.seat,
          display: p.model.display,
          coins: 0,
          hand: [],
          revealed: [],
          alive: true,
          claim: null,
          lastReaction: null,
          note: "",
        }));

      const replayed = replayCoup(data.events, base);
      setFrame(replayed);
      setLive(data.live);
      setResumable(data.resumable);

      const after = data.events.length ? data.events[data.events.length - 1].seq : 0;
      es = new EventSource(`/api/matches/${matchId}/stream?after=${after}`);
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as ArenaEvent;
          setFrame((prev) => {
            // The frame reducer assigns new arrays/objects for everything it
            // changes, so a shallow draft is enough.
            const next: CoupFrame = { ...prev };
            applyCoupEvent(next, event);
            return next;
          });
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false);

      publishPin({
        id: matchId,
        kind: "coup",
        name: base.name,
        phase: replayed.finished ? "done" : "playing",
        round: replayed.turn,
        rounds: typeof spec?.rules?.maxTurns === "number" ? spec.rules.maxTurns : DEFAULT_TURNS,
        settled: replayed.seats.filter((s) => s.alive).length,
        seats: replayed.seats.length,
        ts: Date.now(),
      });
    };

    void boot();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [matchId]);

  const resume = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/matches/${matchId}/recover`, { method: "POST" });
    } finally {
      setBusy(false);
    }
  }, [matchId]);

  // The verdict lands after the last turn; show the scoreboard without making the
  // reader hunt for it.
  useEffect(() => {
    if (!frame.finished || finishedRef.current) return;
    finishedRef.current = true;
    setTab("dossier");
    setPinned(null);
  }, [frame.finished]);

  const alive = frame.seats.filter((s) => s.alive).length;
  const ordered = useMemo(() => {
    const bySeat = new Map(frame.seats.map((s) => [s.seat, s]));
    return POS.map((pos, i) => ({ pos, seat: bySeat.get(i) })).filter(
      (row): row is { pos: string; seat: CoupFrameSeat } => !!row.seat,
    );
  }, [frame.seats]);

  const target = frame.current?.target ?? null;
  const actorSeat = frame.seats.find((s) => s.seat === frame.actor) ?? null;

  const focusSeat = useCallback((seat: number) => {
    setOpenSeat((prev) => (prev === seat ? null : seat));
    setTab("dossier");
    setHead(null);
  }, []);

  const pinTurn = useCallback((turn: number) => {
    setPinned(turn);
    setTab("turn");
    setHead(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRulesOpen(false);
        setHistoryOpen(false);
        setHead(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleHead = useCallback((key: Exclude<HeadKey, null>) => {
    setHead((prev) => (prev === key ? null : key));
  }, []);

  return (
    <main className="mx-auto flex min-h-[calc(100vh-57px)] max-w-[1600px] flex-col gap-2 px-4 py-3">
      <header className="relative flex flex-none flex-wrap items-baseline gap-4 border-b border-line pb-2">
        <h1 className="text-[16px] font-semibold tracking-tight text-fg">{frame.name}</h1>
        <span className="font-mono text-[10px] text-fg-faint">{matchId}</span>
        <div className="ml-auto flex items-baseline gap-1 font-mono text-[10.5px] text-fg-dim">
          <HeadButton
            active={head === "turns"}
            onClick={() => toggleHead("turns")}
            label="手数"
            value={
              <>
                第 <b className="text-fg">{String(frame.turn).padStart(2, "0")}</b>
                <span className="text-fg-faint">/{totalTurns}</span>
              </>
            }
          />
          <HeadButton
            active={head === "deck"}
            onClick={() => toggleHead("deck")}
            label="牌堆"
            value={<b className="text-fg">{frame.deck}</b>}
          />
          <HeadButton
            active={head === "alive"}
            onClick={() => toggleHead("alive")}
            label="存活"
            value={<b className="text-fg">{alive}</b>}
          />
          <span className="mx-2 text-[11px] text-amber">{phaseText(frame)}</span>
          <button
            type="button"
            onClick={() => setRulesOpen(true)}
            className="rounded border border-line-strong px-2.5 py-1 text-fg-dim transition hover:border-amber/50 hover:text-fg"
          >
            规则
          </button>
        </div>
        {head && (
          <HeadPopover frame={frame} which={head} totalTurns={totalTurns} onClose={() => setHead(null)} />
        )}
      </header>

      {!live && resumable && !frame.finished && (
        <div className="flex flex-none items-center gap-3 rounded border border-amber/40 bg-amber/10 px-3 py-1.5 text-[12px] text-fg">
          <span>对局已中断（进程退出）。</span>
          <button
            type="button"
            onClick={resume}
            disabled={busy}
            className="rounded border border-amber/50 px-3 py-0.5 text-[11px] text-amber transition hover:bg-amber/10 disabled:opacity-50"
          >
            {busy ? "恢复中…" : "继续对局"}
          </button>
        </div>
      )}

      <Commentary frame={frame} open={historyOpen} onToggle={() => setHistoryOpen((v) => !v)} />

      <div className="grid h-[calc(100vh-300px)] min-h-[500px] grid-cols-[minmax(0,1fr)_392px] gap-2">
        <section className="relative min-h-0 overflow-hidden rounded-lg border border-line bg-ink-1">
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-[84%] w-[86%] -translate-x-1/2 -translate-y-1/2 rounded-[26px] border border-line bg-ink-2/50" />
          <div className="relative grid h-full grid-cols-[minmax(168px,1fr)_minmax(280px,470px)_minmax(168px,1fr)] grid-rows-[124px_minmax(0,1fr)_124px] gap-2 p-3">
            {ordered.map(({ pos, seat }) => (
              <SeatCard
                key={seat.seat}
                seat={seat}
                pos={pos}
                frame={frame}
                isActor={frame.phase === "action_select" && frame.actor === seat.seat && !frame.finished}
                isClaimant={
                  frame.phase !== "action_select" &&
                  frame.current?.actor === seat.seat &&
                  !frame.finished
                }
                isTarget={target === seat.seat && !frame.finished}
                selected={openSeat === seat.seat && tab === "dossier"}
                onOpen={() => focusSeat(seat.seat)}
              />
            ))}
            <div className="col-start-2 row-start-2 flex h-full min-h-0 w-full place-self-stretch">
              <CenterCard
                frame={frame}
                onOpenTurn={() => {
                  const last = frame.current?.turn ?? frame.turns[frame.turns.length - 1]?.turn ?? null;
                  if (last !== null) pinTurn(last);
                }}
              />
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col rounded-lg border border-line bg-ink-1">
          <Tabs tab={tab} onTab={setTab} frame={frame} />
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "turn" && (
              <TurnTab frame={frame} pinned={pinned} onUnpin={() => setPinned(null)} onPin={pinTurn} />
            )}
            {tab === "dossier" && (
              <DossierTab
                frame={frame}
                openSeat={openSeat}
                onToggleSeat={(seat) => setOpenSeat((prev) => (prev === seat ? null : seat))}
              />
            )}
            {tab === "chronicle" && <ChronicleTab frame={frame} pinned={pinned} onPin={pinTurn} />}
          </div>
        </aside>
      </div>

      <Timeline frame={frame} pinned={pinned} onPin={pinTurn} />

      <RulesDrawer open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </main>
  );
}

/* ── header ────────────────────────────────────────────────────────── */

function HeadButton({
  active,
  onClick,
  label,
  value,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={`flex items-baseline gap-1.5 rounded border px-2 py-1 transition ${
        active
          ? "border-amber/60 bg-amber/10 text-fg"
          : "border-transparent hover:border-line-strong hover:bg-ink-2/60"
      }`}
    >
      <span className="text-fg-faint">{label}</span>
      {value}
    </button>
  );
}

function HeadPopover({
  frame,
  which,
  totalTurns,
  onClose,
}: {
  frame: CoupFrame;
  which: Exclude<HeadKey, null>;
  totalTurns: number;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-3 top-full z-30 mt-1 w-[300px] rounded-lg border border-line-strong bg-ink-1 p-3 shadow-2xl">
      <div className="flex items-baseline gap-2">
        <b className="text-[12px] font-medium text-fg">
          {which === "turns" ? "手数与上限" : which === "deck" ? "牌堆" : "存活座位"}
        </b>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto px-1 text-[12px] text-fg-faint transition hover:text-fg"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5 flex flex-col gap-1 text-[11px] leading-relaxed text-fg-dim">
        {which === "turns" && (
          <>
            <span>
              现在是第 <b className="text-fg">{frame.turn}</b> 手，上限{" "}
              <b className="text-fg">{totalTurns}</b> 手。
            </span>
            <span className="text-fg-faint">
              上限来自蓝图 `rules.maxTurns`。打满上限时按影响力与金币判胜，并列则无胜者。
            </span>
          </>
        )}
        {which === "deck" && (
          <>
            <span>
              牌堆里还剩 <b className="text-fg">{frame.deck}</b> 张。
            </span>
            <span className="text-fg-faint">
              15 张牌 = 五种身份各 3 张。翻开、换掉的牌会洗回牌堆，所以牌堆是「还有多少不知道的牌」，不是「还有多少没用过」。
            </span>
          </>
        )}
        {which === "alive" && (
          <>
            <span>
              还在桌上：{" "}
              {frame.seats
                .filter((s) => s.alive)
                .map((s) => `${s.seat + 1} 号 ${s.display}`)
                .join("、") || "没有人"}
            </span>
            {frame.seats.some((s) => !s.alive) && (
              <span className="text-fg-faint">
                已出局：
                {frame.seats
                  .filter((s) => !s.alive)
                  .map((s) => `${s.seat + 1} 号`)
                  .join("、")}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── commentary ────────────────────────────────────────────────────── */

function Commentary({
  frame,
  open,
  onToggle,
}: {
  frame: CoupFrame;
  open: boolean;
  onToggle: () => void;
}) {
  const text = frame.commentary?.text;
  const count = frame.commentaries.length;
  return (
    <div className="relative flex-none rounded border border-amber/25 bg-amber/[0.06]">
      <button
        type="button"
        onClick={count > 0 ? onToggle : undefined}
        aria-expanded={count > 0 ? open : undefined}
        className={`flex w-full items-start gap-2.5 px-3 py-1.5 text-left ${
          count > 0 ? "cursor-pointer transition hover:bg-amber/[0.04]" : "cursor-default"
        }`}
      >
        <span className="mt-0.5 flex-none rounded bg-amber/15 px-2 py-0.5 text-[10px] font-medium text-amber">
          AI 解说
        </span>
        {frame.commentary && (
          <span className="mt-0.5 flex-none font-mono text-[9px] text-fg-faint">
            T{String(frame.commentary.turn).padStart(2, "0")}
          </span>
        )}
        <p className="min-w-0 flex-1 whitespace-pre-line text-[11.5px] leading-relaxed text-fg-dim">
          {text ??
            (frame.turn > 0
              ? "这一手还没有解说。解说会在每手结算后出现；如果一直为空，说明开局时没有选解说模型。"
              : "等待第一手——解说会在每手结算后出现。")}
        </p>
        <span className="flex-none font-mono text-[9px] text-fg-faint">
          {count > 0 ? (open ? "收起" : `历史 ${count}`) : "只给观众"}
        </span>
      </button>
      {open && count > 0 && (
        <div className="max-h-40 overflow-auto border-t border-amber/20 px-3 py-1.5">
          {[...frame.commentaries].reverse().map((row) => (
            <div key={row.seq} className="flex gap-2 py-0.5 text-[11px] leading-relaxed text-fg-dim">
              <span className="flex-none font-mono text-[9px] text-fg-faint">
                T{String(row.turn).padStart(2, "0")}
              </span>
              <span className="whitespace-pre-line">{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── tabs ──────────────────────────────────────────────────────────── */

function Tabs({ tab, onTab, frame }: { tab: Tab; onTab: (t: Tab) => void; frame: CoupFrame }) {
  const rows: Array<[Tab, string, string]> = [
    ["turn", "本手", frame.current ? `进行中 · 第 ${frame.turn} 手` : "点时间线看任何一手"],
    ["dossier", "档案", "明牌 · 点座位展开"],
    ["chronicle", "编年史", `全部 ${frame.turns.length} 手`],
  ];
  return (
    <div className="flex flex-none border-b border-line">
      {rows.map(([key, label, hint]) => (
        <button
          key={key}
          type="button"
          onClick={() => onTab(key)}
          aria-pressed={tab === key}
          title={hint}
          className={`flex-1 border-b-2 px-2 py-1.5 text-center transition ${
            tab === key
              ? "border-amber bg-amber/[0.06] text-fg"
              : "border-transparent text-fg-faint hover:bg-ink-2/50 hover:text-fg-dim"
          }`}
        >
          <span className="text-[11.5px] font-medium">{label}</span>
        </button>
      ))}
    </div>
  );
}

/* ── table ─────────────────────────────────────────────────────────── */

const SeatCard = memo(function SeatCard({
  seat,
  pos,
  frame,
  isActor,
  isClaimant,
  isTarget,
  selected,
  onOpen,
}: {
  seat: CoupFrameSeat;
  pos: string;
  frame: CoupFrame;
  isActor: boolean;
  isClaimant: boolean;
  isTarget: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const area =
    pos === "n"
      ? "col-start-2 row-start-1 justify-self-center self-start"
      : pos === "w"
        ? "col-start-1 row-start-2 justify-self-start self-center"
        : pos === "e"
          ? "col-start-3 row-start-2 justify-self-end self-center"
          : "col-start-2 row-start-3 justify-self-center self-end";

  const border = isActor
    ? "border-amber/70 shadow-[0_0_0_2px_rgba(255,171,61,0.12)]"
    : isClaimant
      ? "border-amber/40"
      : isTarget
        ? "border-blood/60 shadow-[0_0_0_2px_rgba(194,58,44,0.12)]"
        : selected
          ? "border-jade/60 shadow-[0_0_0_2px_rgba(60,140,120,0.14)]"
          : "border-line";

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={`relative w-full max-w-[210px] cursor-pointer rounded-lg border bg-ink-1 px-2.5 py-2 text-left transition hover:bg-ink-2/40 ${area} ${border}`}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[9.5px] text-fg-faint">
          {String(seat.seat + 1).padStart(2, "0")}
        </span>
        <span
          className={`truncate text-[12px] font-medium ${seat.alive ? "text-fg" : "text-fg-faint line-through"}`}
        >
          {seat.display}
        </span>
        {isActor && (
          <span className="ml-auto flex-none rounded bg-amber px-1.5 py-0.5 text-[8.5px] text-ink-0">
            行动中
          </span>
        )}
        {isTarget && !isActor && (
          <span className="ml-auto flex-none rounded bg-blood px-1.5 py-0.5 text-[8.5px] text-ink-0">
            被瞄准
          </span>
        )}
        {!seat.alive && (
          <span className="ml-auto flex-none rounded bg-blood/15 px-1.5 py-0.5 text-[8.5px] text-blood">
            已出局
          </span>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-[19px] font-semibold leading-none text-amber">{seat.coins}</span>
        <span className="text-[9px] text-fg-faint">枚</span>
        <span className="ml-auto flex gap-1">
          {[0, 1].map((i) => (
            <i
              key={i}
              className={`block h-3 w-2 rounded-sm border ${
                i < seat.hand.length ? "border-jade/50 bg-jade/25" : "border-blood/40 bg-blood/10"
              }`}
            />
          ))}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {seat.hand.map((role, i) => (
          <MiniCard key={`${role}-${i}`} role={role} />
        ))}
        {seat.revealed.map((r, i) => (
          <MiniCard key={`dead-${r.role}-${i}`} role={r.role} dead />
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 border-t border-line pt-1.5 text-[10px]">
        {seat.claim && seat.claim.turn === frame.turn ? (
          <>
            <span className="flex-none text-fg-faint">
              {seat.claim.action === "challenge" || seat.claim.action === "block" ? "回应" : "宣称"}
            </span>
            <span className="truncate text-fg-dim">
              {COUP_ACTION_LABEL[seat.claim.action] ?? seat.claim.action}
              {seat.claim.role ? ` · ${COUP_ROLE_LABEL[seat.claim.role] ?? seat.claim.role}` : ""}
            </span>
          </>
        ) : (
          <span className="truncate text-fg-faint">
            {seat.note ? `正在写：${seat.note.slice(-28)}` : "本手未动"}
          </span>
        )}
      </div>
    </button>
  );
});

function MiniCard({ role, dead }: { role: string; dead?: boolean }) {
  return (
    <div
      className={`flex h-10 min-w-0 flex-1 items-center gap-1.5 rounded border px-1.5 ${
        dead ? "border-blood/40 bg-blood/[0.07]" : "border-line-strong bg-ink-2"
      }`}
    >
      <span className={`text-[12px] ${dead ? "text-blood/70" : "text-amber"}`}>
        {COUP_ROLE_GLYPH[role] ?? "◆"}
      </span>
      <span className={`truncate text-[10.5px] ${dead ? "text-fg-faint line-through" : "text-fg"}`}>
        {COUP_ROLE_LABEL[role] ?? role}
      </span>
    </div>
  );
}

/* ── the table's centre: one glance, plus a door into the details ───── */

function CenterCard({ frame, onOpenTurn }: { frame: CoupFrame; onOpenTurn: () => void }) {
  if (frame.finished) {
    const winner = frame.winner === null ? null : frame.seats.find((s) => s.seat === frame.winner);
    return (
      <div className="flex w-full flex-col justify-center rounded-lg border border-line bg-ink-1 px-4 py-3 text-center">
        <div className="text-[13px] text-fg">
          {winner ? `${winner.seat + 1} 号 ${winner.display} 获胜` : "无人胜出"}
        </div>
        <div className="mt-1 font-mono text-[9.5px] tracking-[0.14em] text-fg-faint">
          {endReasonText(frame.endReason)}
        </div>
      </div>
    );
  }

  const shown = frame.current ?? frame.turns[frame.turns.length - 1] ?? null;
  const actor = frame.seats.find((s) => s.seat === frame.actor);
  const live = !!frame.current;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1.5">
      <div className="flex flex-none items-baseline gap-2 px-1">
        <span className={`text-[12px] ${live ? "text-amber" : "text-fg-dim"}`}>
          {live ? `第 ${frame.turn} 手进行中` : actor ? `轮到 ${actor.seat + 1} 号 ${actor.display}` : "发牌中"}
        </span>
        <span className="ml-auto font-mono text-[9px] tracking-[0.14em] text-fg-faint">{phaseText(frame)}</span>
      </div>
      {shown ? (
        <CenterBody turn={shown} muted={!live} onOpen={onOpenTurn} />
      ) : (
        <div className="rounded-lg border border-line bg-ink-1 px-4 py-4 text-center text-[11.5px] text-fg-faint">
          还没有打出一手。
        </div>
      )}
    </div>
  );
}

function CenterBody({
  turn,
  muted,
  onOpen,
}: {
  turn: CoupTurnRecord;
  muted: boolean;
  onOpen: () => void;
}) {
  const n = describeTurn(turn);
  const bluff = turn.honest === false;
  const progress = useMemo(() => stepProgress(turn), [turn]);

  return (
    <div
      className={`flex min-h-0 w-full flex-1 flex-col gap-1.5 overflow-auto rounded-lg border bg-ink-1 px-3.5 py-2.5 ${
        muted ? "border-line" : bluff ? "border-blood/50" : "border-line-strong"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="flex-none font-mono text-[9.5px] tracking-[0.12em] text-fg-faint">
          {muted ? `上一手 · 第 ${turn.turn} 手` : `第 ${turn.turn} 手`}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[15px] font-semibold ${muted ? "text-fg-dim" : "text-fg"}`}>
          {n.claim}
        </span>
        <span className="flex flex-none items-baseline gap-1.5">
          {turn.role && turn.honest !== null && (
            <span
              className={`rounded px-1.5 py-0.5 text-[9.5px] ${
                bluff ? "bg-blood/15 text-blood" : "bg-jade/15 text-jade"
              }`}
            >
              {bluff ? "诈唬" : "属实"}
            </span>
          )}
          <span className="rounded bg-line px-1.5 py-0.5 text-[9.5px] text-fg-dim">{n.headline}</span>
        </span>
      </div>

      <StepBar progress={progress} />

      <div className={`text-[11px] ${bluff ? "text-blood" : turn.honest === true ? "text-jade" : "text-fg-faint"}`}>
        {n.truth}
      </div>
      <div className="text-[11.5px] italic leading-relaxed text-fg-dim">{n.say}</div>

      {turn.note && (
        <p className="line-clamp-2 border-t border-line pt-1.5 text-[10.5px] leading-relaxed text-fg-faint">
          <span className="mr-1 rounded bg-line px-1 text-[8.5px] text-fg-dim">自述</span>
          {turn.note}
        </p>
      )}

      <button
        type="button"
        onClick={onOpen}
        className="mt-auto flex flex-none items-center justify-center gap-1 rounded border border-line-strong px-2 py-1 text-[10.5px] text-fg-dim transition hover:border-amber/50 hover:text-fg"
      >
        展开这一手的完整时间轴 →
      </button>
    </div>
  );
}

/** Four dots: claim → answer → block → settle, lit by what the record holds. */
function stepProgress(turn: CoupTurnRecord): { label: string; done: boolean }[] {
  const answered =
    turn.reactions.length > 0 || turn.challenge !== null || turn.block !== null || turn.voided !== null;
  const blocked = turn.block !== null || turn.blockChallenge !== null || turn.voided === "block";
  const settled =
    turn.lost.length > 0 ||
    turn.coins.some((c) => c.before !== null && c.before !== c.coins) ||
    turn.voided !== null ||
    (turn.action === "income" && turn.reactions.length === 0);
  return [
    { label: "宣称", done: turn.action !== null },
    { label: "表态", done: answered },
    { label: "阻挡", done: blocked },
    { label: "结算", done: settled },
  ];
}

function StepBar({ progress }: { progress: Array<{ label: string; done: boolean }> }) {
  return (
    <div className="flex items-center gap-1">
      {progress.map((step, i) => (
        <span key={step.label} className="flex items-center gap-1">
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] ${
              step.done ? "bg-amber/15 text-amber" : "bg-line text-fg-faint"
            }`}
          >
            {step.label}
          </span>
          {i < progress.length - 1 && (
            <span className={`h-px w-3 ${step.done ? "bg-amber/40" : "bg-line"}`} />
          )}
        </span>
      ))}
    </div>
  );
}

/* ── tab: this turn ────────────────────────────────────────────────── */

function TurnTab({
  frame,
  pinned,
  onUnpin,
  onPin,
}: {
  frame: CoupFrame;
  pinned: number | null;
  onUnpin: () => void;
  onPin: (turn: number) => void;
}) {
  const shown = useMemo(() => {
    if (pinned !== null) {
      if (frame.current && frame.current.turn === pinned) return frame.current;
      return frame.turns.find((t) => t.turn === pinned) ?? null;
    }
    return frame.current ?? frame.turns[frame.turns.length - 1] ?? null;
  }, [pinned, frame.current, frame.turns]);

  if (!shown) {
    return (
      <div className="px-4 py-6 text-center text-[11.5px] leading-relaxed text-fg-faint">
        还没有打出一手。
        <br />
        发牌完成后，第一手的宣称、每个人的表态与自述都会出现在这里。
      </div>
    );
  }

  const isLive = !!frame.current && frame.current.turn === shown.turn;
  const index = frame.turns.findIndex((t) => t.turn === shown.turn);
  const prev = index > 0 ? frame.turns[index - 1] : null;
  const next = index >= 0 && index < frame.turns.length - 1 ? frame.turns[index + 1] : null;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-3.5 py-1.5">
        <b className="font-mono text-[10px] text-fg-dim">第 {shown.turn} 手</b>
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] ${
            isLive ? "bg-amber/15 text-amber" : "bg-line text-fg-faint"
          }`}
        >
          {isLive ? "进行中" : "已结算"}
        </span>
        <div className="ml-auto flex items-baseline gap-1">
          {prev && (
            <button
              type="button"
              onClick={() => onPin(prev.turn)}
              className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-[9px] text-fg-faint transition hover:border-amber/50 hover:text-fg"
            >
              ← T{String(prev.turn).padStart(2, "0")}
            </button>
          )}
          {next && (
            <button
              type="button"
              onClick={() => onPin(next.turn)}
              className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-[9px] text-fg-faint transition hover:border-amber/50 hover:text-fg"
            >
              T{String(next.turn).padStart(2, "0")} →
            </button>
          )}
          {pinned !== null && (
            <button
              type="button"
              onClick={onUnpin}
              className="rounded border border-amber/50 bg-amber/10 px-1.5 py-0.5 text-[9px] text-amber transition hover:bg-amber/15"
            >
              回到进行中
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <StepBar progress={stepProgress(shown)} />
        <div className="flex flex-col gap-1.5">
          {describeTurnSteps(shown).map((step, i) => (
            <StepRow key={`${step.kind}-${step.seat}-${i}`} step={step} />
          ))}
        </div>
        {isLive && frame.phase !== "action_select" && frame.waiting.length > 0 && (
          <div className="rounded border border-dashed border-amber/40 bg-amber/[0.05] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-amber">
            还在等 {frame.waiting.map((s) => `${s + 1} 号`).join("、")} 表态——收齐后这一步才结算，
            所以他们的原话会在结算的那一刻一起出现。
          </div>
        )}
        {shown.commentary && (
          <div className="rounded border border-amber/25 bg-amber/[0.05] px-2.5 py-2">
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-amber/80">解说</div>
            <p className="mt-0.5 whitespace-pre-line text-[11px] leading-relaxed text-fg-dim">
              {shown.commentary}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const STEP_TONE: Record<CoupTurnStep["kind"], string> = {
  claim: "text-fg",
  reaction: "text-fg-dim",
  block: "text-amber",
  challenge: "text-blood",
  block_challenge: "text-blood",
  lost: "text-blood",
  coins: "text-jade",
  forfeit: "text-amber",
};

function StepRow({ step }: { step: CoupTurnStep }) {
  return (
    <div className="flex gap-2">
      <span className="mt-[2px] w-[42px] flex-none text-right font-mono text-[9px] leading-[1.7] text-fg-faint">
        {step.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[11px] leading-relaxed ${STEP_TONE[step.kind]}`}>{step.text}</p>
        {step.note && <NoteText text={step.note} />}
      </div>
    </div>
  );
}

/** A seat's own note, folded at 120 chars — long ones are worth reading, not skimming. */
function NoteText({ text, limit = 120 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const over = text.length > limit;
  return (
    <p className="mt-0.5 text-[10.5px] leading-relaxed text-fg-faint">
      <span className="mr-1 rounded bg-line px-1 text-[8.5px] text-fg-dim">自述</span>
      {open || !over ? text : `${text.slice(0, limit)}…`}
      {over && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-1 text-[9px] text-fg-faint underline underline-offset-2 transition hover:text-fg-dim"
        >
          {open ? "收起" : `展开全文 · 另 ${text.length - limit} 字`}
        </button>
      )}
    </p>
  );
}

/* ── tab: dossiers ─────────────────────────────────────────────────── */

function DossierTab({
  frame,
  openSeat,
  onToggleSeat,
}: {
  frame: CoupFrame;
  openSeat: number | null;
  onToggleSeat: (seat: number) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-none items-baseline gap-2 border-b border-line px-3.5 py-1 font-mono text-[9px] tracking-[0.14em] text-fg-faint">
        <b className="font-normal text-fg-dim">四家档案</b>
        <span>上帝视角 · 明牌</span>
        <span className="ml-auto">点一行展开</span>
      </div>
      {frame.review && <ReviewPanel frame={frame} />}
      {frame.seats.map((seat) => (
        <SeatRow
          key={seat.seat}
          seat={seat}
          frame={frame}
          open={openSeat === seat.seat}
          onToggle={() => onToggleSeat(seat.seat)}
        />
      ))}
    </div>
  );
}

function SeatRow({
  seat,
  frame,
  open,
  onToggle,
}: {
  seat: CoupFrameSeat;
  frame: CoupFrame;
  open: boolean;
  onToggle: () => void;
}) {
  const bluffs = bluffCount(frame, seat.seat);
  const claims = frame.turns.filter((t) => t.actor === seat.seat && t.role !== null).length;
  const history = useMemo(() => seatNotes(frame, seat.seat), [frame, seat.seat]);
  const writing = !!seat.note && frame.waiting.includes(seat.seat);

  return (
    <section className="border-b border-line">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full cursor-pointer flex-col px-3.5 py-2.5 text-left transition hover:bg-ink-2/40 ${
          frame.actor === seat.seat ? "bg-amber/[0.04]" : ""
        }`}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] text-fg-faint">{String(seat.seat + 1).padStart(2, "0")}</span>
          <span
            className={`truncate text-[12.5px] font-medium ${seat.alive ? "text-fg" : "text-fg-faint line-through"}`}
          >
            {seat.display}
          </span>
          {writing && <span className="rounded bg-amber/15 px-1.5 py-0.5 text-[8.5px] text-amber">在写</span>}
          <span className="ml-auto flex-none font-mono text-[9px] text-fg-faint">
            {seat.alive ? `诈唬 ${bluffs}/${claims}` : "已出局"}
          </span>
          <span className="flex-none font-mono text-[9px] text-fg-faint">{open ? "▾" : "▸"}</span>
        </div>
        <div className="mt-1 flex gap-3 font-mono text-[10.5px] text-fg-dim">
          <span>
            <b className="font-semibold text-amber">{seat.coins}</b> 枚
          </span>
          <span>
            <b className="font-semibold text-fg">{seat.hand.length}</b> 条命
          </span>
          <span className="text-fg-faint">再 {Math.max(0, 7 - seat.coins)} 枚可政变</span>
        </div>
        {!open && (
          <div className="mt-1.5 flex gap-1.5">
            {seat.hand.map((role, i) => (
              <BigCard key={`${role}-${i}`} role={role} />
            ))}
            {seat.revealed.map((r, i) => (
              <BigCard key={`dead-${r.role}-${i}`} role={r.role} dead cause={r.cause} />
            ))}
          </div>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-3.5 pb-3">
          <div className="flex gap-1.5">
            {seat.hand.map((role, i) => (
              <BigCard key={`${role}-${i}`} role={role} />
            ))}
            {seat.revealed.map((r, i) => (
              <BigCard key={`dead-${r.role}-${i}`} role={r.role} dead cause={r.cause} />
            ))}
            {seat.hand.length === 0 && seat.revealed.length === 0 && (
              <span className="text-[10.5px] text-fg-faint">还没有发牌。</span>
            )}
          </div>

          {seat.lastReaction && (
            <div className="text-[10.5px] leading-relaxed text-fg-faint">
              第 {seat.lastReaction.turn} 手回应：
              {COUP_REACTION_LABEL[seat.lastReaction.kind] ?? seat.lastReaction.kind}
              {seat.lastReaction.as ? `（${COUP_ROLE_LABEL[seat.lastReaction.as] ?? seat.lastReaction.as}）` : ""}
              {seat.lastReaction.say ? `「${seat.lastReaction.say}」` : ""}
            </div>
          )}

          <div className="rounded border border-line bg-ink-2/50 px-2.5 py-2">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[8.5px] tracking-[0.14em] text-fg-faint">此刻在想什么</span>
              <span className="text-[8.5px] text-fg-faint">写给观众，对手看不到</span>
              {writing && <span className="ml-auto text-[8.5px] text-amber">正在写…</span>}
            </div>
            <div className="mt-1">
              <ThinkingBody
                text={seat.note}
                done={!writing}
                autoScroll={writing}
                placeholder={
                  seat.alive
                    ? frame.waiting.includes(seat.seat)
                      ? "等他开口。"
                      : "这一轮他没有被叫到。"
                    : "已经出局。"
                }
              />
            </div>
          </div>

          <div>
            <div className="font-mono text-[8.5px] tracking-[0.14em] text-fg-faint">
              历史自述 · {history.length} 条
            </div>
            {history.length === 0 ? (
              <p className="mt-0.5 text-[10.5px] text-fg-faint">还没有写过。</p>
            ) : (
              <div className="mt-1 flex flex-col gap-1">
                {history.map((row, i) => (
                  <div key={`${row.turn}-${row.kind}-${i}`} className="flex gap-1.5">
                    <span className="w-[34px] flex-none font-mono text-[9px] leading-[1.7] text-fg-faint">
                      T{String(row.turn).padStart(2, "0")}
                    </span>
                    <span className="w-[30px] flex-none text-[9px] leading-[1.7] text-fg-faint">{row.kind}</span>
                    <p className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-fg-dim">{row.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Every note a seat wrote, newest first — claim, block and reaction alike. */
function seatNotes(frame: CoupFrame, seat: number): Array<{ turn: number; kind: string; text: string }> {
  const rows: Array<{ turn: number; kind: string; text: string }> = [];
  for (const turn of frame.turns) {
    if (turn.actor === seat && turn.note) rows.push({ turn: turn.turn, kind: "宣称", text: turn.note });
    if (turn.block?.seat === seat && turn.block.note) {
      rows.push({ turn: turn.turn, kind: "阻挡", text: turn.block.note });
    }
    for (const r of turn.reactions) {
      if (r.seat !== seat || !r.note) continue;
      rows.push({ turn: turn.turn, kind: r.kind === "challenge" ? "质疑" : "放过", text: r.note });
    }
  }
  return rows.reverse();
}

/* ── tab: chronicle ────────────────────────────────────────────────── */

function ChronicleTab({
  frame,
  pinned,
  onPin,
}: {
  frame: CoupFrame;
  pinned: number | null;
  onPin: (turn: number) => void;
}) {
  const rows = useMemo(() => [...frame.turns].reverse(), [frame.turns]);
  return (
    <div className="flex flex-col">
      <div className="flex flex-none items-baseline gap-2 border-b border-line px-3.5 py-1 font-mono text-[9px] tracking-[0.14em] text-fg-faint">
        <b className="font-normal text-fg-dim">编年史</b>
        <span>一手一行 · 新的在上</span>
        <span className="ml-auto">共 {frame.turns.length} 手</span>
      </div>
      {frame.current && (
        <button
          type="button"
          onClick={() => onPin(frame.current!.turn)}
          className="flex items-baseline gap-2 border-b border-amber/25 bg-amber/[0.06] px-3.5 py-1.5 text-left transition hover:bg-amber/10"
        >
          <span className="font-mono text-[9px] text-amber">T{String(frame.current.turn).padStart(2, "0")}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg">{describeTurn(frame.current).claim}</span>
          <span className="flex-none text-[9px] text-amber">进行中</span>
        </button>
      )}
      {rows.length === 0 && !frame.current ? (
        <p className="px-3.5 py-4 text-center text-[11px] text-fg-faint">还没有打出一手。</p>
      ) : (
        rows.map((turn) => {
          const n = describeTurn(turn);
          return (
            <button
              key={`${turn.turn}-${turn.seq}`}
              type="button"
              onClick={() => onPin(turn.turn)}
              aria-pressed={pinned === turn.turn}
              className={`flex items-baseline gap-2 border-b border-line px-3.5 py-1.5 text-left transition hover:bg-ink-2/50 ${
                pinned === turn.turn ? "bg-ink-2/70" : ""
              }`}
            >
              <span className="font-mono text-[9px] text-fg-faint">T{String(turn.turn).padStart(2, "0")}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim">{n.claim}</span>
              {turn.honest === false && <span className="flex-none text-[9px] text-blood">诈唬</span>}
              <span className="flex-none max-w-[120px] truncate text-[9px] text-fg-faint">{n.headline}</span>
            </button>
          );
        })
      )}
    </div>
  );
}

/* ── timeline ──────────────────────────────────────────────────────── */

function Timeline({
  frame,
  pinned,
  onPin,
}: {
  frame: CoupFrame;
  pinned: number | null;
  onPin: (turn: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = frame.turns;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [rows.length, frame.turn]);

  return (
    <div className="flex flex-none flex-col rounded border border-line bg-ink-1">
      <div className="flex items-baseline gap-2 border-b border-line px-3.5 py-1 font-mono text-[9px] tracking-[0.14em] text-fg-faint">
        <b className="font-normal text-fg-dim">回合时间线</b>
        <span>每手一张卡 · 点开看完整时间轴</span>
        <span className="ml-auto">共 {rows.length} 手</span>
      </div>
      <div ref={scroller} className="flex gap-2 overflow-x-auto px-3 py-1.5">
        {rows.length === 0 && !frame.current ? (
          <span className="text-[11px] text-fg-faint">还没有打出一手。</span>
        ) : (
          rows.map((turn) => (
            <TurnCard
              key={`${turn.turn}-${turn.seq}`}
              turn={turn}
              selected={pinned === turn.turn}
              onOpen={() => onPin(turn.turn)}
            />
          ))
        )}
        {frame.current && (
          <LiveTurnCard
            turn={frame.current}
            selected={pinned === frame.current.turn}
            onOpen={() => onPin(frame.current!.turn)}
          />
        )}
      </div>
    </div>
  );
}

const TurnCard = memo(function TurnCard({
  turn,
  selected,
  onOpen,
}: {
  turn: CoupTurnRecord;
  selected: boolean;
  onOpen: () => void;
}) {
  const n = describeTurn(turn);
  const bluff = turn.honest === false;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={`flex w-[280px] flex-none cursor-pointer flex-col gap-0.5 overflow-hidden rounded border px-2 py-1 text-left transition hover:border-amber/50 hover:bg-ink-2/70 ${
        selected ? "border-amber/70 bg-ink-2/80" : "border-line bg-ink-2"
      }`}
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="flex-none font-mono text-[8.5px] text-fg-faint">T{String(turn.turn).padStart(2, "0")}</span>
        <span className="min-w-0 truncate text-[11px] text-fg">{n.claim}</span>
        {turn.role && turn.honest !== null && (
          <span className={`ml-auto flex-none text-[9px] ${bluff ? "text-blood" : "text-jade"}`}>
            {bluff ? "诈唬" : "属实"}
          </span>
        )}
      </div>
      {turn.say && (
        <div className="min-w-0 truncate text-[10px] italic text-fg-faint">「{turn.say}」</div>
      )}
      {n.forfeits.length > 0 && (
        <div className="min-w-0 truncate text-[10px] text-amber">{n.forfeits[0]}</div>
      )}
      <div className="line-clamp-2 min-w-0 text-[10.5px] leading-snug text-fg-dim">{n.results[0]}</div>
      <div className="flex min-w-0 items-center gap-1.5">
        {turn.note && <span className="text-[8.5px] text-fg-faint">自述 {turn.note.length} 字</span>}
        {turn.commentary && <span className="text-[8.5px] text-amber/80">解说</span>}
        {turn.lost.length > 0 && <span className="text-[8.5px] text-blood">掉命</span>}
      </div>
    </button>
  );
});

/** The turn in flight is not in `turns` yet; the timeline still has to show it. */
const LiveTurnCard = memo(function LiveTurnCard({
  turn,
  selected,
  onOpen,
}: {
  turn: CoupTurnRecord;
  selected: boolean;
  onOpen: () => void;
}) {
  const n = describeTurn(turn);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={`flex w-[280px] flex-none cursor-pointer flex-col gap-0.5 overflow-hidden rounded border border-dashed border-amber/50 bg-amber/[0.05] px-2 py-1 text-left transition hover:border-amber hover:bg-amber/10 ${
        selected ? "border-solid bg-amber/10" : ""
      }`}
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="flex-none font-mono text-[8.5px] text-amber">
          T{String(turn.turn).padStart(2, "0")}
        </span>
        <span className="min-w-0 truncate text-[11px] text-fg">{n.claim}</span>
        <span className="ml-auto flex-none text-[9px] text-amber">进行中</span>
      </div>
      {turn.say && (
        <div className="min-w-0 truncate text-[10px] italic text-fg-faint">「{turn.say}」</div>
      )}
      <div className="min-w-0 truncate text-[10.5px] text-fg-dim">{n.headline}</div>
    </button>
  );
});

/* ── review ────────────────────────────────────────────────────────── */

function ReviewPanel({ frame }: { frame: CoupFrame }) {
  const review = frame.review;
  if (!review) return null;
  const ranked = [...review.seats].sort((a, b) => b.total - a.total);
  return (
    <div className="border-b border-line bg-ink-2/40">
      <div className="flex items-baseline gap-2 border-b border-line px-3.5 py-1 font-mono text-[9px] tracking-[0.14em] text-fg-faint">
        <b className="font-normal text-fg-dim">赛后评分</b>
        {review.provisional && <span className="text-amber">样本不足</span>}
        <span className="ml-auto">
          最会玩：{review.champion === null ? "并列" : `${review.champion + 1} 号`}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 py-2">
        {ranked.map((row) => (
          <div key={row.seat} className="flex items-baseline gap-2 text-[10.5px] text-fg-dim">
            <span className="font-mono text-[9px] text-fg-faint">{String(row.seat + 1).padStart(2, "0")}</span>
            <span className="truncate">{frame.seats.find((s) => s.seat === row.seat)?.display ?? ""}</span>
            <span className="ml-auto font-mono text-[11px] text-amber">{row.total.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────── */

function endReasonText(reason: string | null): string {
  switch (reason) {
    case "last_standing":
      return "最后一人存活";
    case "all_eliminated":
      return "全员出局";
    case "turn_limit":
      return "回合上限 · 按影响力与金币判胜";
    case "turn_limit_tie":
      return "回合上限 · 并列";
    default:
      return reason ? `GAME OVER · ${reason}` : "GAME OVER";
  }
}

function BigCard({ role, dead, cause }: { role: string; dead?: boolean; cause?: string }) {
  return (
    <div
      className={`flex h-[52px] min-w-0 flex-1 flex-col justify-center gap-0.5 rounded border px-2 ${
        dead ? "border-blood/40 bg-blood/[0.07]" : "border-line-strong bg-ink-2"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`text-[13px] ${dead ? "text-blood/70" : "text-amber"}`}>
          {COUP_ROLE_GLYPH[role] ?? "◆"}
        </span>
        <span className={`truncate text-[11px] ${dead ? "text-fg-faint line-through" : "text-fg"}`}>
          {COUP_ROLE_LABEL[role] ?? role}
        </span>
      </div>
      <span className="truncate font-mono text-[8.5px] text-fg-faint">
        {dead ? causeText(cause) : powerOf(role)}
      </span>
    </div>
  );
}

function causeText(cause?: string): string {
  switch (cause) {
    case "assassinated":
      return "被刺杀";
    case "coup":
      return "被政变";
    case "challenge_lost":
      return "质疑失败";
    case "challenge_failed":
      return "诈唬被拆穿";
    default:
      return "已失去";
  }
}

function powerOf(role: string): string {
  switch (role) {
    case "duke":
      return "征税 3 枚 · 可挡外援";
    case "assassin":
      return "付 3 枚 · 取一条命";
    case "captain":
      return "偷 2 枚 · 可挡偷窃";
    case "ambassador":
      return "换牌 · 可挡偷窃";
    case "contessa":
      return "只挡刺杀";
    default:
      return "";
  }
}

/* ── rules ─────────────────────────────────────────────────────────── */

function RulesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div
      className={`fixed inset-y-0 right-0 z-40 flex w-[430px] max-w-full flex-col border-l border-line bg-ink-1 shadow-2xl transition-transform duration-200 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      aria-hidden={!open}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[15px] font-semibold text-fg">规则</h2>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto px-1.5 text-[15px] text-fg-faint transition hover:text-fg"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <SectionTitle>七种行动</SectionTitle>
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-fg-faint">
              <th className="border-b border-line-strong px-1.5 pb-1 text-left font-normal">行动</th>
              <th className="border-b border-line-strong px-1.5 pb-1 text-left font-normal">效果</th>
              <th className="border-b border-line-strong px-1.5 pb-1 text-left font-normal">可质疑</th>
              <th className="border-b border-line-strong px-1.5 pb-1 text-left font-normal">可阻挡</th>
              <th className="border-b border-line-strong px-1.5 pb-1 text-left font-normal">谁能挡</th>
            </tr>
          </thead>
          <tbody>
            {ACTION_ROWS.map(([name, effect, challengeable, blockable, who]) => (
              <tr key={name}>
                <td className="border-b border-line px-1.5 py-1.5 font-medium text-fg">{name}</td>
                <td className="border-b border-line px-1.5 py-1.5 text-fg-dim">{effect}</td>
                <td className="border-b border-line px-1.5 py-1.5">
                  <YesNo value={challengeable} />
                </td>
                <td className="border-b border-line px-1.5 py-1.5">
                  <YesNo value={blockable} />
                </td>
                <td className="border-b border-line px-1.5 py-1.5 text-fg-dim">{who}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <SectionTitle>五种身份</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {Object.keys(COUP_ROLE_LABEL).map((role) => (
            <div key={role} className="rounded border border-line bg-ink-2 px-2.5 py-2">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[13px] text-amber">{COUP_ROLE_GLYPH[role]}</span>
                <span className="text-[12px] font-medium text-fg">{COUP_ROLE_LABEL[role]}</span>
              </div>
              <div className="mt-1 text-[10.5px] leading-relaxed text-fg-dim">{powerOf(role)}</div>
            </div>
          ))}
        </div>

        <SectionTitle>一次行动的结算顺序</SectionTitle>
        <ol className="flex flex-col gap-2">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="flex gap-2 text-[11.5px] leading-relaxed text-fg-dim">
              <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border border-line-strong font-mono text-[9px] text-fg-faint">
                {i + 1}
              </span>
              <span>
                <b className="font-medium text-fg">{title}</b>：{text}
              </span>
            </li>
          ))}
        </ol>

        <SectionTitle>看不懂时看这里</SectionTitle>
        <div className="flex flex-col gap-1.5 text-[11.5px] leading-relaxed text-fg-dim">
          {Object.entries(COUP_ACTION_EFFECT).map(([key, text]) => (
            <div key={key}>
              <b className="font-medium text-fg">{COUP_ACTION_LABEL[key]}</b>：{text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-4 flex items-center gap-2 font-mono text-[9px] tracking-[0.14em] text-fg-faint first:mt-0">
      <span className="text-fg-dim">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function YesNo({ value }: { value: boolean }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[9.5px] ${
        value ? "border-jade/40 text-jade" : "border-line-strong text-fg-faint"
      }`}
    >
      {value ? "是" : "否"}
    </span>
  );
}

function safeParse(raw: string): { name?: string; rules?: { maxTurns?: number } } | null {
  try {
    return JSON.parse(raw) as { name?: string; rules?: { maxTurns?: number } };
  } catch {
    return null;
  }
}
