/**
 * Coup view model. Pure: the UI is a reducer over the event stream.
 *
 * The audience sees every hand. That is the whole point of a god-view table —
 * the models never get this data, only this file does.
 *
 * One turn is the unit of narration. `current` collects the turn in flight and
 * `turns` keeps the settled ones, so the table never loses "what just happened"
 * the moment the next turn starts.
 */

import { COUP_ACTION_ZH, COUP_ROLE_ZH } from "@/engine/coup/turn";
import type { ArenaEvent } from "@/engine/types";
import { applyTurnEvent, emptyTurn, type CoupTurnRecord } from "@/engine/coup/turn";

export const COUP_ROLE_LABEL: Record<string, string> = { ...COUP_ROLE_ZH };

export const COUP_ROLE_GLYPH: Record<string, string> = {
  duke: "♛",
  assassin: "†",
  captain: "⚓",
  ambassador: "✉",
  contessa: "☾",
};

export const COUP_ACTION_LABEL: Record<string, string> = { ...COUP_ACTION_ZH };

/** One-line effect, for the audience that has never played Coup. */
export const COUP_ACTION_EFFECT: Record<string, string> = {
  income: "拿 1 枚，不可质疑",
  foreign_aid: "拿 2 枚，公爵可挡",
  coup: "付 7 枚，取一条命",
  tax: "公爵 · 拿 3 枚",
  steal: "队长 · 拿 2 枚",
  assassinate: "刺客 · 付 3 枚，取一条命",
  exchange: "大使 · 抽 2 换 2",
};

export const COUP_REACTION_LABEL: Record<string, string> = {
  pass: "放过",
  challenge: "质疑",
  block: "阻挡",
};

export const COUP_PHASE_LABEL: Record<string, string> = {
  dealing: "发牌",
  action_select: "选行动",
  action_reaction: "等表态",
  block_reaction: "等回应阻挡",
  influence_lose: "等翻牌",
  exchange_pick: "等换牌",
  done: "终局",
};

export interface CoupFrameSeat {
  seat: number;
  display: string;
  coins: number;
  hand: string[];
  revealed: Array<{ role: string; turn: number; cause: string }>;
  alive: boolean;
  /** The seat's most recent identity claim, with the audience-only truth flag. */
  claim: { turn: number; action: string; role: string | null; honest: boolean | null } | null;
  /** The seat's most recent reaction to someone else's claim. */
  lastReaction: { turn: number; kind: string; as: string | null; say: string } | null;
  /** Audience note the seat wrote for this turn (channel === "note" only). */
  note: string;
}

export interface CoupFrame {
  matchId: string;
  name: string;
  turn: number;
  phase: string;
  actor: number | null;
  deck: number;
  seats: CoupFrameSeat[];
  /** The turn in flight; null between turns. */
  current: CoupTurnRecord | null;
  /** Settled turns, oldest first. */
  turns: CoupTurnRecord[];
  /** Seats the current phase is still waiting on. */
  waiting: number[];
  winner: number | null;
  finished: boolean;
  endReason: string | null;
  live: boolean;
  /** Latest commentary line; kept for the header strip. */
  commentary: { seq: number; turn: number; text: string } | null;
  commentaries: Array<{ seq: number; turn: number; text: string }>;
  /** Post-game review, once the verdict lands. */
  review: {
    champion: number | null;
    provisional: boolean;
    seats: Array<{
      seat: number;
      total: number;
      dimensions: Record<string, number>;
      ballots: number;
      selfTotal: number | null;
    }>;
  } | null;
}

export function emptyCoupFrame(matchId: string): CoupFrame {
  return {
    matchId,
    name: "政变 · 四人桌",
    turn: 0,
    phase: "dealing",
    actor: null,
    deck: 15,
    seats: [],
    current: null,
    turns: [],
    waiting: [],
    winner: null,
    finished: false,
    endReason: null,
    live: false,
    commentary: null,
    commentaries: [],
    review: null,
  };
}

export function coupFrameFromRoster(
  matchId: string,
  name: string,
  seats: Array<{ seat: number; display: string }>,
): CoupFrame {
  const frame = emptyCoupFrame(matchId);
  frame.name = name;
  frame.seats = seats.map((s) => ({
    seat: s.seat,
    display: s.display,
    coins: 0,
    hand: [],
    revealed: [],
    alive: true,
    claim: null,
    lastReaction: null,
    note: "",
  }));
  return frame;
}

function patchSeat(frame: CoupFrame, seat: number, patch: (s: CoupFrameSeat) => CoupFrameSeat): void {
  frame.seats = frame.seats.map((s) => (s.seat === seat ? patch(s) : s));
}

/**
 * The live note stream is the model writing in real time; the copy that lands on
 * `coup.action` / `coup.reaction` is clipped by the engine. Keeping the shorter
 * one made a seat's note visibly shrink the moment its move was accepted.
 */
function longerNote(live: string, landed: string): string {
  return landed.length >= live.length ? landed : live;
}

function closeTurn(frame: CoupFrame): void {
  if (!frame.current) return;
  // The turn in flight may still be waiting on a flip/exchange after the last
  // action; keep whatever was collected so the timeline never shows a hole.
  if (frame.current.action !== null) frame.turns = [...frame.turns, frame.current];
  frame.current = null;
}

/** Apply one event. Mutates a draft the caller owns; never reads global state. */
export function applyCoupEvent(frame: CoupFrame, event: ArenaEvent): void {
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case "coup.dealt": {
      const hands = Array.isArray(payload.hands) ? (payload.hands as Array<{ seat: number; cards: Array<{ role: string }> }>) : [];
      const coins = Array.isArray(payload.coins) ? (payload.coins as Array<{ seat: number; coins: number }>) : [];
      for (const hand of hands) {
        patchSeat(frame, hand.seat, (s) => ({ ...s, hand: hand.cards.map((c) => c.role) }));
      }
      for (const row of coins) {
        patchSeat(frame, row.seat, (s) => ({ ...s, coins: row.coins }));
      }
      frame.deck = typeof payload.deck === "number" ? payload.deck : frame.deck;
      frame.phase = "action_select";
      break;
    }
    case "coup.turn": {
      closeTurn(frame);
      frame.turn = Number(payload.turn ?? frame.turn);
      frame.actor = typeof payload.actor === "number" ? payload.actor : null;
      frame.phase = "action_select";
      frame.waiting = frame.actor === null ? [] : [frame.actor];
      if (typeof payload.deck === "number") frame.deck = payload.deck;
      const coins = Array.isArray(payload.coins) ? (payload.coins as Array<{ seat: number; coins: number }>) : [];
      for (const row of coins) patchSeat(frame, row.seat, (s) => ({ ...s, coins: row.coins }));
      const alive = Array.isArray(payload.alive) ? (payload.alive as number[]) : null;
      if (alive) {
        for (const seat of frame.seats) {
          const isAlive = alive.includes(seat.seat);
          if (seat.alive !== isAlive) patchSeat(frame, seat.seat, (s) => ({ ...s, alive: isAlive }));
        }
      }
      break;
    }
    case "phase.changed": {
      frame.phase = typeof payload.phase === "string" ? payload.phase : frame.phase;
      const queue = Array.isArray(payload.queue) ? (payload.queue as number[]) : [];
      frame.waiting = [...queue];
      // Each phase starts a fresh note; the stream only writes for the seats it calls.
      for (const seat of queue) {
        patchSeat(frame, seat, (s) => ({ ...s, note: "" }));
      }
      break;
    }
    case "coup.action": {
      const seat = Number(payload.seat);
      const action = String(payload.action ?? "income");
      const role = typeof payload.role === "string" ? payload.role : null;
      const honest = typeof payload.honest === "boolean" ? payload.honest : null;
      const note = String(payload.note ?? "");
      frame.current = applyTurnEvent(frame.current ?? emptyTurn(frame.turn), event);
      if (role) {
        patchSeat(frame, seat, (s) => ({
          ...s,
          claim: { turn: frame.turn, action, role, honest },
          note: longerNote(s.note, note),
        }));
      } else {
        patchSeat(frame, seat, (s) => ({ ...s, note: longerNote(s.note, note) }));
      }
      if (typeof payload.coinsAfter === "number") {
        patchSeat(frame, seat, (s) => ({ ...s, coins: payload.coinsAfter as number }));
      }
      frame.waiting = [];
      break;
    }
    case "coup.reaction": {
      const seat = Number(payload.seat);
      const kind = String(payload.kind ?? "pass");
      const note = String(payload.note ?? "");
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      if (note) patchSeat(frame, seat, (s) => ({ ...s, note: longerNote(s.note, note) }));
      frame.waiting = frame.waiting.filter((s) => s !== seat);
      patchSeat(frame, seat, (s) => ({
        ...s,
        lastReaction: {
          turn: frame.turn,
          kind,
          as: typeof payload.as === "string" ? payload.as : null,
          say: String(payload.say ?? ""),
        },
      }));
      break;
    }
    case "coup.block": {
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      break;
    }
    case "coup.challenge": {
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      break;
    }
    case "coup.forfeit": {
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      break;
    }
    case "coup.lost": {
      const seat = Number(payload.seat);
      const role = String(payload.role ?? "");
      const cause = String(payload.cause ?? "");
      patchSeat(frame, seat, (s) => {
        const hand = [...s.hand];
        const idx = hand.indexOf(role);
        if (idx >= 0) hand.splice(idx, 1);
        return {
          ...s,
          hand,
          revealed: [...s.revealed, { role, turn: frame.turn, cause }],
          alive: Number(payload.remaining ?? 1) > 0,
        };
      });
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      frame.waiting = frame.waiting.filter((s) => s !== seat);
      break;
    }
    case "coup.coins": {
      const rows = Array.isArray(payload.coins) ? (payload.coins as Array<{ seat: number; coins: number }>) : [];
      for (const row of rows) patchSeat(frame, row.seat, (s) => ({ ...s, coins: row.coins }));
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      break;
    }
    case "coup.hand": {
      const seat = Number(payload.seat);
      const cards = Array.isArray(payload.cards) ? (payload.cards as Array<{ role: string }>) : [];
      patchSeat(frame, seat, (s) => ({ ...s, hand: cards.map((c) => c.role) }));
      break;
    }
    case "coup.exchange": {
      const seat = Number(payload.seat);
      const kept = Array.isArray(payload.kept) ? (payload.kept as string[]) : [];
      patchSeat(frame, seat, (s) => ({ ...s, hand: kept }));
      if (typeof payload.deck === "number") frame.deck = payload.deck;
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      frame.waiting = frame.waiting.filter((s) => s !== seat);
      break;
    }
    case "coup.result": {
      if (frame.current) frame.current = applyTurnEvent(frame.current, event);
      break;
    }
    case "coup.finished": {
      closeTurn(frame);
      frame.finished = true;
      frame.winner = typeof payload.winner === "number" ? payload.winner : null;
      frame.endReason = typeof payload.reason === "string" ? payload.reason : null;
      frame.phase = "done";
      frame.waiting = [];
      const coins = Array.isArray(payload.coins) ? (payload.coins as Array<{ seat: number; coins: number }>) : [];
      for (const row of coins) patchSeat(frame, row.seat, (s) => ({ ...s, coins: row.coins }));
      break;
    }
    case "seat.thinking.delta": {
      // Only the audience note is for the audience. The native reasoning channel
      // is the model's scratch pad: showing it was the "看不懂" bug.
      if (payload.channel !== "note") break;
      const seat = Number(payload.seat);
      const delta = String(payload.delta ?? "");
      if (!delta) break;
      patchSeat(frame, seat, (s) => ({ ...s, note: (s.note + delta).slice(-900) }));
      break;
    }
    case "coup.commentary": {
      const text = String(payload.text ?? "");
      const turn = Number(payload.turn ?? frame.turn);
      if (!text) break;
      frame.commentary = { seq: event.seq, turn, text };
      frame.commentaries = [...frame.commentaries, { seq: event.seq, turn, text }].slice(-80);
      // Attach to the settled turn with the same number (commentary is async).
      let attached = false;
      frame.turns = frame.turns.map((t) => {
        if (!attached && t.turn === turn) {
          attached = true;
          return { ...t, commentary: text };
        }
        return t;
      });
      break;
    }
    case "review.verdict": {
      const seats = Array.isArray(payload.seats) ? payload.seats : [];
      frame.review = {
        champion: typeof payload.champion === "number" ? payload.champion : null,
        provisional: payload.provisional === true,
        seats: seats as NonNullable<CoupFrame["review"]>["seats"],
      };
      break;
    }
    case "anomaly": {
      // Anomalies are surfaced in the header, not mixed into the turn timeline.
      break;
    }
    default:
      break;
  }
}

export function replayCoup(events: ArenaEvent[], frame: CoupFrame): CoupFrame {
  const next: CoupFrame = {
    ...frame,
    seats: frame.seats.map((s) => ({ ...s })),
    turns: [],
    commentaries: [],
    current: null,
  };
  for (const event of events) applyCoupEvent(next, event);
  return next;
}

/** Bluffs a seat actually committed (audience-only truth). */
export function bluffCount(frame: CoupFrame, seat: number): number {
  return frame.turns.filter((t) => t.actor === seat && t.honest === false).length;
}

/** Human sentence for the phase label: who we are waiting on, in plain Chinese. */
export function phaseText(frame: CoupFrame): string {
  if (frame.finished) return "终局";
  if (frame.phase === "dealing") return "发牌中";
  const wait = frame.waiting.length ? frame.waiting.map((s) => `${s + 1} 号`).join("、") : "";
  switch (frame.phase) {
    case "action_select":
      return frame.actor === null ? "等下一手" : `等 ${frame.actor + 1} 号选行动`;
    case "action_reaction":
      return wait ? `等 ${wait} 表态` : "等表态";
    case "block_reaction":
      return wait ? `等 ${wait} 回应阻挡` : "等回应阻挡";
    case "influence_lose":
      return wait ? `等 ${wait} 翻牌` : "等翻牌";
    case "exchange_pick":
      return wait ? `等 ${wait} 换牌` : "等换牌";
    default:
      return COUP_PHASE_LABEL[frame.phase] ?? frame.phase;
  }
}
