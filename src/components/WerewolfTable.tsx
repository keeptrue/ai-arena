"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ArenaEvent, ModelSnapshot } from "@/engine/types";
import type { TableExportPayload } from "@/lib/table-export";
import type { DeathCause, WerewolfCamp, WerewolfPhase, WerewolfRoleId } from "@/engine/werewolf/types";
import {
  DEATH_LABEL,
  PHASE_CHIP,
  ROLE_LABEL,
  actionFromContent,
  applyReviewDelta,
  applyReviewStarted,
  blankSeat,
  emptyReview,
  emptyTable,
  reasonLabel,
  reviewChampion,
  reviewRubric,
  reviewSeat,
  reviewWeightSet,
  tableFromRoster,
  type TableAction,
  type TableLogItem,
  type TableReviewBallot,
  type TableReviewBallotBody,
  type TableReviewSeatResult,
  type TableReviewVerdict,
  type TableSeatView,
  type TableState,
  type TableThought,
  type TableVoteRecord,
} from "@/lib/werewolf-frame";
import { publishPin } from "@/lib/pin";
import { ExportMenu } from "./ExportMenu";
import { WerewolfReel } from "./WerewolfReel";
import { WerewolfReview } from "./WerewolfReview";

export type {
  TableAction,
  TableLogItem,
  TableSeatView,
  TableState,
  TableThought,
  TableVoteRecord,
};
export { emptyTable, tableFromRoster };

/* ── reducer helpers ───────────────────────────────────────────────── */

function patchSeat(
  seats: TableSeatView[],
  seat: number,
  patch: (s: TableSeatView) => TableSeatView,
): TableSeatView[] {
  return seats.map((s) => (s.seat === seat ? patch(s) : s));
}

function markDead(
  seats: TableSeatView[],
  seat: number,
  cause?: DeathCause,
  day?: number,
): TableSeatView[] {
  return patchSeat(seats, seat, (s) => ({
    ...s,
    alive: false,
    status: "dead",
    death: { cause: cause ?? s.death?.cause, day: day ?? s.death?.day },
  }));
}

function logItem(
  event: ArenaEvent,
  day: number,
  text: string,
  tone: TableLogItem["tone"],
  kind: string,
  seat?: number,
  phase?: WerewolfPhase,
): TableLogItem {
  return { seq: event.seq, day, text, tone, kind, seat, phase };
}

/** One row per (day, phase, seat): a later event for the same turn replaces it. */
function upsertAction(actions: TableAction[], action: TableAction): TableAction[] {
  const idx = actions.findIndex(
    (a) => a.day === action.day && a.phase === action.phase && a.seat === action.seat,
  );
  if (idx < 0) return [...actions, action];
  const next = [...actions];
  next[idx] = action;
  return next;
}

function patchAction(
  actions: TableAction[],
  match: (a: TableAction) => boolean,
  patch: (a: TableAction) => TableAction,
): TableAction[] {
  return actions.map((a) => (match(a) ? patch(a) : a));
}

function numRecord(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[Number(k)] = n;
  }
  return out;
}

function voteRecord(raw: unknown): Record<number, number | "abstain"> {
  const out: Record<number, number | "abstain"> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "abstain") out[Number(k)] = "abstain";
    else if (typeof v === "number") out[Number(k)] = v;
    else if (typeof v === "string" && /^\d+$/.test(v)) out[Number(k)] = Number(v);
  }
  return out;
}

/** Pure event-stream reducer for the table. Exported so the replay rules stay testable. */
export function applyWerewolfEvent(state: TableState, event: ArenaEvent): TableState {
  const p = event.payload as Record<string, any>;
  const day = typeof p.day === "number" ? p.day : state.day;
  switch (event.type) {
    case "match.created": {
      const incoming = Array.isArray(p.seats) ? (p.seats as Array<{ seat: number; participantId: string }>) : [];
      const seats = state.seats.length
        ? state.seats.map((s) => {
            const row = incoming.find((x) => x.seat === s.seat);
            return row ? { ...s, participantId: row.participantId } : s;
          })
        : Array.from({ length: 9 }, (_, seat) => {
            const row = incoming.find((x) => x.seat === seat);
            return blankSeat(seat, row?.participantId ?? `seat-${seat}`);
          });
      return {
        ...state,
        meta: {
          name: String(p.name ?? "九人局"),
          tagline: String(p.tagline ?? ""),
          maxDays: Number(p.maxDays ?? 8),
          briefing: String(p.briefing ?? ""),
        },
        seats,
        phase: "dealing",
        actions: [],
      };
    }

    case "roles.dealt": {
      const rows = Array.isArray(p.seats) ? (p.seats as Array<{ seat: number; role: WerewolfRoleId; camp: WerewolfCamp }>) : [];
      const seats = state.seats.map((s) => {
        const row = rows.find((x) => x.seat === s.seat);
        return row ? { ...s, role: row.role, camp: row.camp } : s;
      });
      const text = rows
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((r) => `${r.seat + 1}号${ROLE_LABEL[r.role] ?? r.role}`)
        .join("、");
      return {
        ...state,
        seats,
        godLog: [...state.godLog, logItem(event, state.day, `发牌：${text}（${p.source ?? "engine"}）`, "ghost", "roles")],
      };
    }

    case "round.opened":
      return { ...state, day, phase: (p.phase as WerewolfPhase) ?? state.phase };

    case "phase.changed": {
      const phase = (p.phase as WerewolfPhase) ?? state.phase;
      const clearVotes =
        phase === "night_wolves" ||
        phase === "night_seer" ||
        phase === "night_witch" ||
        phase === "dawn" ||
        phase === "day_speech" ||
        phase === "day_vote" ||
        phase === "done";
      return {
        ...state,
        day,
        phase,
        spoken: phase === "day_speech" || phase === "day_pk_speech" ? 0 : state.spoken,
        speaking: null,
        votes: clearVotes ? {} : state.votes,
        counts: clearVotes ? {} : state.counts,
        pk: phase === "day_pk_speech" || phase === "day_pk_vote" ? state.pk : [],
        seats: state.seats.map((s) => ({
          ...s,
          status: s.alive ? "idle" : "dead",
          thinking: "",
          reasoning: "",
          thinkingDone: false,
          action: null,
          vote: null,
        })),
      };
    }

    case "seat.thinking.delta": {
      if (p.phase && p.phase !== state.phase) return state;
      const seat = Number(p.seat ?? event.seat);
      const delta = typeof p.delta === "string" ? p.delta : "";
      // Old events have no channel; they were the audience note.
      const channel = p.channel === "reason" ? "reason" : "note";
      const speaking =
        state.phase === "day_speech" ||
        state.phase === "day_pk_speech" ||
        state.phase === "day_last_words"
          ? seat
          : state.speaking;
      return {
        ...state,
        speaking,
        seats: patchSeat(state.seats, seat, (s) => ({
          ...s,
          thinking: channel === "note" ? s.thinking + delta : s.thinking,
          reasoning: channel === "reason" ? s.reasoning + delta : s.reasoning,
          thinkingDone: false,
          status: s.status === "ready" || s.status === "forfeit" ? s.status : "thinking",
        })),
      };
    }

    case "seat.submitted": {
      if (p.phase && p.phase !== state.phase) return state;
      const seat = Number(p.seat ?? event.seat);
      const content = (p.content ?? {}) as Record<string, unknown>;
      const phase = (p.phase as WerewolfPhase) ?? state.phase;
      const current = state.seats.find((s) => s.seat === seat);
      const thinking =
        typeof p.thinking === "string" && p.thinking ? p.thinking : current?.thinking ?? "";
      const reasoning =
        typeof p.reasoning === "string" && p.reasoning ? p.reasoning : current?.reasoning ?? "";
      const thought: TableThought | null =
        thinking || reasoning
          ? { day, phase, seat, text: thinking, native: reasoning }
          : null;
      const thinkingHistory = thought
        ? [
            ...state.thinkingHistory.filter((t) => !(t.day === day && t.phase === phase && t.seat === seat)),
            thought,
          ]
        : state.thinkingHistory;
      const action = actionFromContent({ seq: event.seq, day, phase, seat, content });
      return {
        ...state,
        thinkingHistory,
        actions: action ? upsertAction(state.actions, action) : state.actions,
        seats: patchSeat(state.seats, seat, (s) => ({
          ...s,
          status: "ready",
          action: content,
          thinkingDone: true,
          thinking,
          reasoning,
          vote: content.kind === "vote" ? (content.target as number | "abstain") : s.vote,
        })),
      };
    }

    case "seat.forfeit": {
      if (p.phase && p.phase !== state.phase) return state;
      const seat = Number(p.seat ?? event.seat);
      const phase = (p.phase as WerewolfPhase) ?? state.phase;
      const reason = String(p.reason ?? "");
      const action: TableAction = {
        seq: event.seq,
        day,
        phase,
        seat,
        kind: "forfeit",
        tag: "弃",
        label: "弃权",
        target: null,
        detail: reason,
        tone: "muted",
      };
      return {
        ...state,
        actions: upsertAction(state.actions, action),
        seats: patchSeat(state.seats, seat, (s) => ({ ...s, status: "forfeit", thinkingDone: true })),
      };
    }

    case "seat.afk": {
      const seat = Number(p.seat ?? event.seat);
      return {
        ...state,
        seats: patchSeat(state.seats, seat, (s) => ({ ...s, afk: true })),
        godLog: [...state.godLog, logItem(event, state.day, `${seat + 1}号掉线，后续按弃权处理`, "amber", "afk", seat)],
      };
    }

    case "speech": {
      const seat = Number(p.seat);
      const pk = p.pk === true;
      return {
        ...state,
        spoken: state.spoken + 1,
        seats: patchSeat(state.seats, seat, (s) => ({ ...s, lastSpeech: String(p.text ?? "") })),
        publicLog: [
          ...state.publicLog,
          logItem(
            event,
            day,
            `${seat + 1}号${pk ? "（PK）" : ""}发言：${String(p.text ?? "")}`,
            "muted",
            "speech",
            seat,
            state.phase,
          ),
        ],
      };
    }

    case "self_destruct": {
      const seat = Number(p.seat);
      return {
        ...state,
        spoken: state.spoken + 1,
        seats: markDead(state.seats, seat, "self_destruct", day).map((s) =>
          s.seat === seat ? { ...s, role: "wolf" as const, camp: "wolf" as const } : s,
        ),
        publicLog: [...state.publicLog, logItem(event, day, `${seat + 1}号狼人自爆`, "blood", "self_destruct", seat)],
        godLog: [...state.godLog, logItem(event, day, `${seat + 1}号自爆（狼人）`, "blood", "self_destruct", seat)],
      };
    }

    case "wolf.chat": {
      const seat = Number(p.seat);
      return {
        ...state,
        godLog: [...state.godLog, logItem(event, day, `${seat + 1}号狼队低语：${String(p.text ?? "")}`, "blood", "wolf.chat", seat)],
      };
    }

    case "seer.check": {
      const seat = Number(p.seat);
      const target = Number(p.target);
      const verdict = p.result === "wolf" ? "狼人" : "好人";
      return {
        ...state,
        actions: patchAction(
          state.actions,
          (a) => a.day === day && a.phase === "night_seer" && a.seat === seat,
          (a) => ({ ...a, detail: verdict }),
        ),
        godLog: [
          ...state.godLog,
          logItem(
            event,
            day,
            `${seat + 1}号预言家验 ${target + 1}号：${verdict}`,
            "ghost",
            "seer.check",
            seat,
          ),
        ],
      };
    }

    case "night.resolved": {
      const deathRows = Array.isArray(p.deaths)
        ? (p.deaths as Array<{ seat: number; cause: DeathCause }>)
        : [];
      const deaths = deathRows.length
        ? deathRows.map((d) => `${d.seat + 1}号（${DEATH_LABEL[d.cause]}）`).join("、")
        : "无人";
      const bits = [
        p.killTarget !== null && p.killTarget !== undefined ? `刀 ${Number(p.killTarget) + 1}号` : "空刀",
        p.saved ? "解药救起" : "",
        p.poisonTarget !== null && p.poisonTarget !== undefined ? `毒 ${Number(p.poisonTarget) + 1}号` : "",
      ].filter(Boolean);
      const resolve: TableAction = {
        seq: event.seq,
        day,
        phase: "dawn",
        seat: null,
        kind: "resolve",
        tag: "结算",
        label: bits.join(" · ") || "平安夜",
        target: null,
        detail: deathRows.length ? `出局 ${deaths}` : "无人出局",
        tone: "ghost",
      };
      return {
        ...state,
        actions: upsertAction(state.actions, resolve),
        godLog: [...state.godLog, logItem(event, day, `夜晚：${bits.join("，")}；死亡 ${deaths}`, "amber", "night.resolved")],
      };
    }

    case "dawn": {
      const deaths = Array.isArray(p.deaths) ? (p.deaths as number[]) : [];
      const text = deaths.length
        ? `天亮：${deaths.map((n) => `${n + 1}号`).join("、")} 出局`
        : "天亮：平安夜";
      let seats = state.seats;
      for (const seat of deaths) seats = markDead(seats, seat);
      return {
        ...state,
        seats,
        speaking: null,
        publicLog: [...state.publicLog, logItem(event, day, text, deaths.length ? "blood" : "jade", "dawn")],
      };
    }

    case "vote.tally": {
      const counts = numRecord(p.counts);
      const votes = voteRecord(p.votes);
      const tie = Array.isArray(p.tie) ? (p.tie as number[]) : [];
      const countsText =
        Object.entries(counts)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([seat, n]) => `${Number(seat) + 1}号${n}票`)
          .join("，") || "无人得票";
      const verdict =
        p.exiled !== null && p.exiled !== undefined
          ? `${Number(p.exiled) + 1}号被放逐`
          : tie.length
            ? `平票：${tie.map((n) => `${n + 1}号`).join("、")}`
            : "无人出局";
      const seats = state.seats.map((s) => ({
        ...s,
        vote: votes[s.seat] ?? null,
        voteCount: counts[s.seat] ?? 0,
      }));
      const detail = Object.entries(votes)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([from, to]) => `${Number(from) + 1}号→${to === "abstain" ? "弃票" : `${Number(to) + 1}号`}`)
        .join("，");
      const record: TableVoteRecord = {
        day,
        counts,
        votes,
        exiled: p.exiled === null || p.exiled === undefined ? null : Number(p.exiled),
        tie,
        pk: p.pk === true,
      };
      return {
        ...state,
        seats,
        votes,
        counts,
        voteHistory: [...state.voteHistory.filter((v) => !(v.day === day && v.pk === record.pk)), record],
        publicLog: [
          ...state.publicLog,
          logItem(event, day, `投票：${countsText}；${verdict}${detail ? `；票型：${detail}` : ""}`, "amber", "vote"),
        ],
      };
    }

    case "pk.opened": {
      const pk = Array.isArray(p.candidates) ? (p.candidates as number[]) : [];
      return {
        ...state,
        pk,
        publicLog: [
          ...state.publicLog,
          logItem(event, day, `平票，${pk.map((n) => `${n + 1}号`).join("、")}进入 PK`, "amber", "pk"),
        ],
      };
    }

    case "exile": {
      const seat = Number(p.seat);
      return {
        ...state,
        seats: markDead(state.seats, seat, "vote", day),
        publicLog: [...state.publicLog, logItem(event, day, `${seat + 1}号被放逐`, "blood", "exile", seat)],
      };
    }

    case "no_exile": {
      const reason = p.reason === "tie" ? "平票，无人出局" : "无人投票，无人出局";
      return {
        ...state,
        publicLog: [...state.publicLog, logItem(event, day, reason, "muted", "no_exile")],
      };
    }

    case "hunter.shot": {
      const seat = Number(p.seat);
      const target = p.target === null || p.target === undefined ? null : Number(p.target);
      const action: TableAction = {
        seq: event.seq,
        day,
        phase: "hunter_shot",
        seat,
        kind: "hunter",
        tag: "枪",
        label: target !== null ? `开枪 ${target + 1}号` : "不开枪",
        target,
        detail: "",
        tone: "blood",
      };
      return {
        ...state,
        actions: upsertAction(state.actions, action),
        seats: target !== null ? markDead(state.seats, target, "hunter", day) : state.seats,
        publicLog: [
          ...state.publicLog,
          logItem(
            event,
            day,
            target !== null ? `${seat + 1}号猎人开枪带走 ${target + 1}号` : `${seat + 1}号猎人未开枪`,
            "blood",
            "hunter",
            seat,
            state.phase,
          ),
        ],
      };
    }

    case "last_words": {
      const seat = Number(p.seat);
      const text = String(p.text ?? "") || "（无言）";
      return {
        ...state,
        seats: patchSeat(state.seats, seat, (s) => ({ ...s, lastWords: text })),
        publicLog: [
          ...state.publicLog,
          logItem(event, day, `${seat + 1}号遗言：${text}`, "muted", "last_words", seat, state.phase),
        ],
      };
    }

    case "seat.died": {
      const seat = Number(p.seat);
      const cause = p.cause as DeathCause | undefined;
      return {
        ...state,
        speaking: state.speaking === seat ? null : state.speaking,
        seats: markDead(state.seats, seat, cause, day),
        godLog: [
          ...state.godLog,
          logItem(event, day, `${seat + 1}号出局（${cause ? DEATH_LABEL[cause] : "未知"}）`, "blood", "died", seat),
        ],
      };
    }

    case "match.finished": {
      const roles = Array.isArray(p.roles) ? (p.roles as Array<{ seat: number; role: WerewolfRoleId; camp: WerewolfCamp }>) : [];
      const seats = state.seats.map((s) => {
        const row = roles.find((x) => x.seat === s.seat);
        return row ? { ...s, role: row.role, camp: row.camp } : s;
      });
      const name = p.winnerName ? String(p.winnerName) : null;
      const reason = String(p.reason ?? "");
      return {
        ...state,
        seats,
        finished: true,
        phase: "done",
        winner: { camp: (p.winnerCamp as WerewolfCamp) ?? null, name, reason },
        publicLog: [
          ...state.publicLog,
          logItem(event, day, name ? `终局：${name}胜（${reasonLabel(reason)}）` : `终局：无胜者（${reasonLabel(reason)}）`, name ? "jade" : "muted", "finish"),
        ],
      };
    }

    /* ── post-game review ───────────────────────────────────────── */

    // A new attempt is a new round: old ballots and the old verdict must not leak
    // into it. The same attempt can re-open after a crash, so that case only
    // refreshes the rubric the review was planned with.
    case "review.opened": {
      const attempt = Number(p.attempt ?? 0);
      if (!Number.isInteger(attempt) || attempt <= 0) return state;
      if (attempt < state.review.attempt) return state;
      const rubric = reviewRubric(p.rubric);
      const raters = Array.isArray(p.raters)
        ? (p.raters as unknown[]).filter(
            (r): r is number | "judge" =>
              r === "judge" || (typeof r === "number" && Number.isInteger(r)),
          )
        : [];
      const expected = Number(p.expected);
      const total = Number.isFinite(expected) && expected > 0 ? expected : 0;
      if (attempt === state.review.attempt) {
        return {
          ...state,
          review: {
            ...state.review,
            openedAt: state.review.openedAt ?? event.ts,
            expected: total || state.review.expected,
            raters: raters.length ? raters : state.review.raters,
            rubric: rubric ?? state.review.rubric,
          },
        };
      }
      return {
        ...state,
        review: {
          ...emptyReview(),
          attempt,
          opened: true,
          openedAt: event.ts,
          running: true,
          expected: total,
          raters,
          rubric,
        },
      };
    }

    // The panel typewrites while a ballot is being written: never a table fact,
    // always live-only (the export drops these, the ballot carries the answer).
    case "review.rater.started": {
      const attempt = Number(p.attempt ?? 0);
      const rater = p.rater === "judge" ? "judge" : Number(p.rater);
      if (rater !== "judge" && !Number.isInteger(rater)) return state;
      return {
        ...state,
        review: applyReviewStarted(state.review, { attempt, rater, ts: event.ts }),
      };
    }

    case "review.thinking.delta": {
      const attempt = Number(p.attempt ?? 0);
      const rater = p.rater === "judge" ? "judge" : Number(p.rater);
      if (rater !== "judge" && !Number.isInteger(rater)) return state;
      const review = applyReviewDelta(state.review, {
        attempt,
        rater,
        channel: String(p.channel ?? "note"),
        delta: typeof p.delta === "string" ? p.delta : "",
        ts: event.ts,
      });
      return review === state.review ? state : { ...state, review };
    }

    // One row per rater: a repeated ballot overwrites, it never stacks a second vote.
    case "review.ballot": {
      const attempt = Number(p.attempt ?? 0);
      if (!Number.isInteger(attempt) || attempt < state.review.attempt) return state;
      const rater = p.rater === "judge" ? "judge" : Number(p.rater);
      if (rater !== "judge" && !Number.isInteger(rater)) return state;
      const base =
        attempt > state.review.attempt
          ? { ...emptyReview(), attempt, opened: true, running: true }
          : state.review;
      const ok = p.status === "ok" || (p.status == null && !!p.ballot);
      const body =
        p.ballot && typeof p.ballot === "object"
          ? (p.ballot as TableReviewBallotBody)
          : null;
      const entry: TableReviewBallot = {
        rater,
        status: ok ? "ok" : "forfeit",
        ballot: ok ? body : null,
        error: typeof p.error === "string" ? p.error : "",
      };
      const key = rater === "judge" ? "judge" : `seat:${rater}`;
      const ballots = [
        ...base.ballots.filter(
          (b) => (b.rater === "judge" ? "judge" : `seat:${b.rater}`) !== key,
        ),
        entry,
      ];
      return { ...state, review: { ...base, running: true, ballots } };
    }

    // A verdict closes its attempt. A stale verdict (an attempt already replaced)
    // must never overwrite the round the table is actually watching.
    case "review.verdict": {
      const attempt = Number(p.attempt ?? 0);
      if (!Number.isInteger(attempt) || attempt < state.review.attempt) return state;
      if (!Array.isArray(p.ranking)) return state;
      const missing: Array<number | "judge"> = Array.isArray(p.raters?.missing)
        ? (p.raters.missing as Array<number | "judge">)
        : [];
      const verdict: TableReviewVerdict = {
        attempt,
        weights: reviewWeightSet(
          p.weights,
          state.review.rubric?.weights ?? state.review.verdict?.weights,
        ),
        ranking: p.ranking as TableReviewSeatResult[],
        mvp: typeof p.mvp === "number" ? p.mvp : null,
        bestSpeech: typeof p.bestSpeech === "number" ? p.bestSpeech : null,
        bestDeception: typeof p.bestDeception === "number" ? p.bestDeception : null,
        provisional: p.provisional === true,
        judge: p.judge === true,
        raters: {
          players: Number(p.raters?.players ?? 0),
          judge: p.raters?.judge === true,
          missing,
        },
        usage:
          p.usage && typeof p.usage === "object"
            ? { calls: Number(p.usage.calls ?? 0), tokens: Number(p.usage.tokens ?? 0) }
            : undefined,
        reason: typeof p.reason === "string" ? p.reason : undefined,
      };
      return {
        ...state,
        review: {
          ...state.review,
          attempt,
          opened: true,
          running: false,
          expected: Math.max(state.review.expected, verdict.raters.players),
          verdict,
        },
      };
    }

    case "anomaly": {
      const code = String(p.code ?? "anomaly");
      // A review failure is not a table fact, but it explains a 9/10 ballot that
      // never arrives — leave it in the operator log instead of the public one.
      const fromReview = code.startsWith("review_");
      const text = `${fromReview ? "评分异常：" : ""}${code}${
        p.message ? ` — ${String(p.message)}` : ""
      }`;
      return {
        ...state,
        godLog: [
          ...state.godLog,
          logItem(event, day, text, "amber", fromReview ? "review" : "anomaly"),
        ],
      };
    }

    case "dm.intervened": {
      const paused = p.kind === "pause" ? true : p.kind === "resume" ? false : state.paused;
      return {
        ...state,
        paused,
        godLog: [...state.godLog, logItem(event, day, `场外：${String(p.kind ?? "dm")}`, "ghost", "dm")],
      };
    }

    case "match.recovered": {
      const minutes = typeof p.gapMs === "number" ? Math.max(1, Math.round(p.gapMs / 60_000)) : null;
      return {
        ...state,
        status: "running",
        live: true,
        paused: p.paused === true,
        godLog: [
          ...state.godLog,
          logItem(
            event,
            state.day,
            `对局已从断点恢复${minutes ? `（中断约 ${minutes} 分钟）` : ""}`,
            "jade",
            "recover",
          ),
        ],
      };
    }

    case "seat.recalled": {
      if (p.phase && p.phase !== state.phase) return state;
      const seat = Number(p.seat ?? event.seat);
      // The dead run's half-written thought must not bleed into the new call.
      return {
        ...state,
        seats: patchSeat(state.seats, seat, (s) => ({
          ...s,
          status: "thinking",
          thinking: "",
          reasoning: "",
          thinkingDone: false,
        })),
      };
    }

    case "state.updated": {
      if (p.paused === true) return { ...state, paused: true };
      if (p.paused === false) return { ...state, paused: false };
      return state;
    }

    default:
      return state;
  }
}

/* ── snapshot fold ─────────────────────────────────────────────────── */

export interface TableFoldInput {
  participants: Array<{ id: string; seat: number; model: ModelSnapshot }>;
  events: ArenaEvent[];
  status: string;
  live: boolean;
  judgeDisplay: string | null;
  /** Older streams can be trimmed; the status read still knows the verdict. */
  carriedVerdict?: TableReviewVerdict | null;
  reviewAttempt?: number;
}

/**
 * Fold a roster + event stream into the table view.
 *
 * The live page and the exported file must agree on every frame, so both go
 * through this one function: the boot effect no longer keeps its own copy.
 */
export function foldTableView(input: TableFoldInput): TableState {
  let view = tableFromRoster(input.participants);
  for (const event of input.events) view = applyWerewolfEvent(view, event);
  const carried = input.carriedVerdict;
  if (!view.review.verdict && carried && Array.isArray(carried.ranking)) {
    view = {
      ...view,
      review: {
        ...view.review,
        attempt: Math.max(view.review.attempt, input.reviewAttempt ?? 0),
        opened: true,
        running: false,
        expected: Math.max(view.review.expected, carried.raters.players),
        verdict: carried,
      },
    };
  }
  return {
    ...view,
    status: input.status,
    live: input.live,
    judgeName: input.judgeDisplay,
  };
}

/* ── labels ────────────────────────────────────────────────────────── */

function phaseTone(phase: WerewolfPhase): string {
  if (phase === "done") return "text-fg-dim border-line bg-ink-2";
  if (phase === "day_vote" || phase === "day_pk_vote") return "text-amber border-amber/30 bg-amber/10";
  if (phase.startsWith("night") || phase === "dawn") return "text-ghost border-ghost/30 bg-ghost/10";
  return "text-jade border-jade/30 bg-jade/10";
}

/* ── component ─────────────────────────────────────────────────────── */

export function WerewolfTable({
  matchId,
  snapshot,
}: {
  matchId: string;
  /** A frozen export payload: no fetch, no stream, no write controls. */
  snapshot?: TableExportPayload;
}) {
  const [view, setView] = useState<TableState>(() =>
    snapshot
      ? foldTableView({
          participants: snapshot.roster.participants,
          events: snapshot.events,
          status: snapshot.match.status,
          live: snapshot.match.status === "running",
          judgeDisplay: snapshot.judge?.display ?? null,
        })
      : emptyTable(),
  );
  const [godView, setGodView] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Is anything driving this match, is there a checkpoint to rewind to, and is a
  // review still collecting ballots? All three come from the same status read.
  const [link, setLink] = useState<{
    live: boolean;
    resumable: boolean;
    reviewLive: boolean;
    reviewResumable: boolean;
  }>(() =>
    snapshot
      ? {
          live: snapshot.match.status === "running",
          resumable: false,
          reviewLive: false,
          reviewResumable: false,
        }
      : { live: true, resumable: false, reviewLive: false, reviewResumable: false },
  );
  // Bumping this re-runs the boot effect: a recovery has to re-read the log and
  // reopen the stream, because the page opened before the match was alive again.
  const [reload, setReload] = useState(0);
  const lastSeq = useRef(0);
  const pending = useRef<ArenaEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ww-god-view");
      if (saved === "0") setGodView(false);
    } catch {
      /* private mode: the default god view is fine */
    }
  }, []);

  useEffect(() => {
    // An exported file is already folded: no status read, no stream, no writes.
    if (snapshot) return;
    let cancelled = false;
    let source: EventSource | null = null;

    const flush = () => {
      timer.current = null;
      const batch = pending.current;
      pending.current = [];
      const fresh = batch.filter((e) => e.seq > lastSeq.current);
      if (fresh.length === 0) return;
      lastSeq.current = fresh[fresh.length - 1].seq;
      setView((v) => fresh.reduce(applyWerewolfEvent, v));
    };
    const enqueue = (events: ArenaEvent[]) => {
      pending.current.push(...events);
      if (timer.current == null) timer.current = setTimeout(flush, 16);
    };

    type MatchPage = {
      match: { status: string };
      roster?: { participants: Array<{ id: string; seat: number; model: ModelSnapshot }> };
      events: ArenaEvent[];
      hasMore?: boolean;
      nextAfter?: number;
      live?: boolean;
      resumable?: boolean;
      judge?: { display?: string } | null;
      review?: {
        live?: boolean;
        resumable?: boolean;
        attempt?: number;
        opened?: boolean;
        verdict?: TableReviewVerdict | null;
      } | null;
    };

    async function boot() {
      try {
        const read = async (after: number): Promise<MatchPage | null> => {
          const res = await fetch(`/api/matches/${matchId}?after=${after}`, { cache: "no-store" });
          if (res.status === 404) return null;
          return (await res.json()) as MatchPage;
        };

        const first = await read(0);
        if (!first) {
          if (!cancelled) setView({ ...emptyTable(), notFound: true });
          return;
        }
        if (cancelled) return;

        // Long matches can exceed one API page (thinking deltas dominate the stream).
        // Page through the tail so a finished match still reaches its final events.
        let events = first.events;
        let page = first;
        let guard = 0;
        while (page.hasMore && guard < 20) {
          const cursor = page.nextAfter ?? (events.length ? events[events.length - 1].seq : 0);
          const next = await read(cursor);
          if (!next || next.events.length === 0) break;
          events = events.concat(next.events);
          page = next;
          guard += 1;
        }
        if (cancelled) return;

        lastSeq.current = events.length ? events[events.length - 1].seq : 0;
        setView(
          foldTableView({
            participants: first.roster?.participants ?? [],
            events,
            status: first.match.status,
            live: first.live !== false,
            judgeDisplay: first.judge?.display ?? null,
            carriedVerdict: first.review?.verdict ?? null,
            reviewAttempt: first.review?.attempt,
          }),
        );
        setLink({
          live: first.live !== false,
          resumable: first.resumable === true,
          reviewLive: first.review?.live === true,
          reviewResumable: first.review?.resumable === true,
        });
        // The stream stays open after the last vote: the review runs on the same
        // event flow, so ballots and the verdict land without a reload. A finished
        // match that closed its stream here used to show a review that never moved.
        source = new EventSource(`/api/matches/${matchId}/stream?after=${lastSeq.current}`);
        // A restarted server reconnects the stream silently; re-read the truth so the
        // page stops claiming a dead match is still thinking.
        source.onopen = () => void refreshLink();
        source.onmessage = (ev) => {
          try {
            enqueue([JSON.parse(ev.data) as ArenaEvent]);
          } catch {
            /* ignore malformed frame */
          }
        };
      } catch {
        if (!cancelled) setView((v) => ({ ...v, notFound: true }));
      }
    }

    void boot();
    return () => {
      cancelled = true;
      if (timer.current != null) clearTimeout(timer.current);
      source?.close();
    };
  }, [matchId, reload, snapshot]);

  const alive = view.seats.filter((s) => s.alive).length;
  const camps = useMemo(() => {
    let wolf = 0;
    let god = 0;
    let villager = 0;
    for (const s of view.seats) {
      if (!s.alive) continue;
      if (s.role === "wolf") wolf += 1;
      else if (s.role === "seer" || s.role === "witch" || s.role === "hunter") god += 1;
      else if (s.role === "villager") villager += 1;
    }
    return { wolf, god, villager };
  }, [view.seats]);

  useEffect(() => {
    if (!view.meta) return;
    document.title = `${PHASE_CHIP[view.phase] ?? "对局"} · 第 ${view.day} 天 · ${view.meta.name} · 斗场`;
    // A file:// export must not rewrite the reader's "last match" pin.
    if (snapshot) return;
    publishPin({
      id: matchId,
      kind: "werewolf",
      name: view.meta.name,
      phase: view.finished ? "done" : view.paused ? "paused" : "playing",
      round: view.day,
      rounds: view.meta.maxDays,
      settled: alive,
      seats: 9,
      ts: Date.now(),
    });
  }, [matchId, view.meta, view.phase, view.day, view.finished, view.paused, alive, snapshot]);

  if (view.notFound) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-24 text-center">
        <p className="text-[15px] text-fg-dim">这一桌不存在，或者已经被清掉了。</p>
        <a href="/" className="mt-4 inline-block text-[13px] text-jade underline underline-offset-4">
          回开局页
        </a>
      </main>
    );
  }

  if (!view.meta) {
    return (
      <main className="mx-auto max-w-[1500px] px-6 py-10">
        <div className="panel h-[420px] animate-pulse bg-ink-1/50" />
      </main>
    );
  }

  const showPrivate = godView || view.finished;
  // Dead, but not settled: nobody is driving and the status says so too.
  const stalled =
    !snapshot &&
    !link.live &&
    !view.finished &&
    view.status !== "aborted" &&
    view.status !== "failed";
  // The review's own headline: the table's best seat, named from the roster because
  // the review events carry seat numbers only.
  const champion = reviewChampion(view.review.verdict);
  const championSeat = champion ? reviewSeat(view, champion.seat) : null;

  /** Re-read the log from the start: a new attempt rewrites the whole review tail. */
  function refreshReview() {
    setReload((n) => n + 1);
  }

  /**
   * Seats the engine is willing to re-open: their forfeit belongs to the phase the
   * table is sitting in. Once the phase turns, the status resets and they drop out.
   */
  const recallable = view.seats.filter((s) => s.status === "forfeit");

  /** Hand a seat its turn back after a cut that produced nothing at all. */
  async function recall(seat: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/intervene`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "recall", seat }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; code?: string };
      if (!res.ok || !data.ok) {
        if (data.code === "not_running") await refreshLink();
        throw new Error(data.error ?? "补叫失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: "pause" | "resume") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/intervene`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; code?: string };
      if (!res.ok || !data.ok) {
        // `not_running` is not a failed click: the runtime is gone. Re-read the
        // header flags so the recovery button appears instead of a dead banner.
        if (data.code === "not_running") await refreshLink();
        throw new Error(data.error ?? "操作失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Cheap status read: status / live / resumable, one event at most. */  async function refreshLink() {
    try {
      const res = await fetch(`/api/matches/${matchId}?after=${lastSeq.current}&limit=1`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        match?: { status?: string };
        live?: boolean;
        resumable?: boolean;
        review?: { live?: boolean; resumable?: boolean } | null;
      };
      setLink({
        live: data.live !== false,
        resumable: data.resumable === true,
        reviewLive: data.review?.live === true,
        reviewResumable: data.review?.resumable === true,
      });
      const status = data.match?.status;
      setView((v) => ({ ...v, live: data.live !== false, ...(status ? { status } : {}) }));
    } catch {
      /* the banner already says what happened */
    }
  }

  async function recover() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/recover`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "续跑失败");
      // Re-read the log and reopen the stream: this page was loaded while the
      // match was still dead.
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshLink();
    } finally {
      setBusy(false);
    }
  }

  async function abort() {
    const ask = link.live
      ? "中止这一局？事件流会保留，但不会继续推进。"
      : "这一局已经停了，标记为已中止？之后只能回放。";
    if (!window.confirm(ask)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/abort`, { method: "POST" });
      if (!res.ok) throw new Error("中止失败");
      setView((v) => ({ ...v, status: "aborted" }));
      setLink((prev) => ({ ...prev, live: false, resumable: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Finished tables carry the review panel below the reel, so the page itself
  // has to scroll; `data-finished` is what hands the scroll back to the
  // document (see the finished block in globals.css).
  return (
    <main
      className="ww-page mx-auto max-w-[1500px] px-6"
      data-phase={view.phase}
      data-day={view.day}
      data-finished={view.finished ? "true" : undefined}
    >
      <header className="ww-page-head flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-[20px] font-semibold tracking-tight">{view.meta.name}</h1>
            <span className={`rounded border px-2 py-0.5 text-[10px] ${phaseTone(view.phase)}`}>
              {PHASE_CHIP[view.phase] ?? view.phase}
            </span>
            {stalled && (
              <span className="rounded border border-amber/30 bg-amber/10 px-2 py-0.5 text-[10px] text-amber">
                已中断
              </span>
            )}
            {snapshot && (
              <span
                title={`导出于 ${new Date(snapshot.exportedAt).toLocaleString("zh-CN", { hour12: false })}`}
                className="rounded border border-line px-2 py-0.5 text-[10px] text-fg-faint"
              >
                离线快照
              </span>
            )}
            {view.paused && <span className="text-[11px] text-amber">已暂停</span>}
            {view.winner && (
              <span className={`text-[11px] ${view.winner.camp === "wolf" ? "text-blood" : "text-jade"}`}>
                {view.winner.name ? `${view.winner.name}胜` : "无胜者"} · {reasonLabel(view.winner.reason)}
              </span>
            )}
            {champion && (
              <span
                title={view.review.verdict?.provisional ? "样本不足，仅供参考" : "赛后评分第一名"}
                className="rounded border border-jade/30 bg-jade/10 px-2 py-0.5 text-[10px] text-jade"
              >
                {view.review.verdict?.provisional ? "参考第一" : "最会玩"}：{champion.seat + 1}号 ·{" "}
                {championSeat?.display ?? "未知模型"} · {champion.total.toFixed(1)}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[13px] text-fg-dim">{view.meta.tagline}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="label">存活</span>
            <span className="mono text-fg-dim">{alive}/9</span>
            {showPrivate ? (
              <>
                <span className="label ml-2">狼</span>
                <span className="mono text-blood">{camps.wolf}</span>
                <span className="label">神</span>
                <span className="mono text-amber">{camps.god}</span>
                <span className="label">民</span>
                <span className="mono text-fg-dim">{camps.villager}</span>
              </>
            ) : (
              <span className="text-[11px] text-fg-faint">玩家视角 · 阵营构成隐藏</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(!snapshot || !view.finished) && (
            <button
              type="button"
              onClick={() => {
                setGodView((v) => {
                  const next = !v;
                  try {
                    window.localStorage.setItem("ww-god-view", next ? "1" : "0");
                  } catch {
                    /* best effort */
                  }
                  return next;
                });
              }}
              className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg"
            >
              {godView ? "玩家视角" : "上帝视角"}
            </button>
          )}
          {!snapshot && (
            <>
              {link.live && recallable.length > 0 && !view.finished
                ? recallable.map((s) => (
                    <button
                      key={s.seat}
                      type="button"
                      onClick={() => void recall(s.seat)}
                      disabled={busy}
                      title="这个座位被判弃权，而本阶段还没收尾：可以重叫它一次，弃权计数会一并回滚"
                      className="rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-[12px] text-amber transition hover:bg-amber/15 disabled:opacity-40"
                    >
                      补叫 {s.seat + 1} 号
                    </button>
                  ))
                : null}
              <button
                type="button"
                onClick={() => void act(view.paused ? "resume" : "pause")}
                disabled={busy || view.finished || !link.live}
                className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg disabled:opacity-40"
              >
                {view.paused ? "继续" : "暂停"}
              </button>
              {link.resumable && (
                <button
                  type="button"
                  onClick={() => void recover()}
                  disabled={busy}
                  className="rounded-md border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade transition hover:bg-jade/15 disabled:opacity-40"
                >
                  从断点继续
                </button>
              )}
              <button
                type="button"
                onClick={() => void abort()}
                disabled={busy || view.finished}
                className="rounded-md border border-blood/30 px-3 py-1.5 text-[12px] text-blood transition hover:border-blood/60 disabled:opacity-40"
              >
                中止
              </button>
              <ExportMenu matchId={matchId} />
            </>
          )}
        </div>
      </header>

      {stalled && (
        <div className="panel mb-4 border-amber/30 px-3 py-2 text-[12px] text-amber">
          <p>
            这一局停在「第 {view.day} 天 · {PHASE_CHIP[view.phase] ?? view.phase}」：进程重启后没人推进。
          </p>
          {link.resumable ? (
            <p className="mt-0.5">
              点「从断点继续」只会补叫还欠动作的座位，已经交过卷的不会重跑。
            </p>
          ) : (
            <p className="mt-0.5 text-fg-faint">
              这一局没有断点（建于断点功能之前，或断点写入失败），只能当回放看。想收尾就点「中止」。
            </p>
          )}
        </div>
      )}

      {error && <p className="panel mb-4 border-blood/30 px-3 py-2 text-[12px] text-blood">{error}</p>}

      <WerewolfReel view={view} godView={godView} revealed={view.finished} />

      {view.finished && (
        <WerewolfReview
          review={view.review}
          seats={view.seats}
          matchId={matchId}
          finished={view.finished}
          judgeName={view.judgeName}
          live={link.reviewLive}
          resumable={link.reviewResumable}
          onRefresh={refreshReview}
          exportMode={Boolean(snapshot)}
        />
      )}

      <div className="ww-page-foot flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-faint">
        <span>胶片按夜 / 天分帧，点一格回放</span>
        <span>旁白只给观众，对手与裁判不可见</span>
        <span>
          {godView
            ? "上帝视角：底牌、夜行与思考可见"
            : view.finished
              ? "玩家视角：终局已翻牌"
              : "玩家视角：只显示公开信息"}
        </span>
        {snapshot && (
          <span>
            离线快照 ·{" "}
            {new Date(snapshot.exportedAt).toLocaleString("zh-CN", { hour12: false })}
          </span>
        )}
      </div>
    </main>
  );
}
