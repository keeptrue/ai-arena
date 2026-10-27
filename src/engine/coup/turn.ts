/**
 * One settled turn, folded out of the event stream.
 *
 * The reducer clears `state.claim` before the next `coup.turn` lands, so the
 * audience-side story of a turn cannot be rebuilt from `state` afterwards.
 * This module folds the events of one turn into a single record. Both the view
 * model and the commentary runtime consume it, so the facts they show never
 * diverge.
 *
 * Pure: no I/O, no `Date.now()`, no engine state. Only events in, record out.
 */

import type { ArenaEvent } from "../types";
import type { CoupActionKind, CoupRole } from "./types";

export const COUP_ACTION_ZH: Record<CoupActionKind, string> = {
  income: "收入",
  foreign_aid: "外援",
  coup: "政变",
  tax: "征税",
  steal: "偷窃",
  assassinate: "刺杀",
  exchange: "换牌",
};

export const COUP_ROLE_ZH: Record<CoupRole, string> = {
  duke: "公爵",
  assassin: "刺客",
  captain: "队长",
  ambassador: "大使",
  contessa: "伯爵夫人",
};

export const COUP_CAUSE_ZH: Record<string, string> = {
  challenge_lost: "质疑失败",
  challenge_failed: "诈唬被拆穿",
  assassinated: "被刺杀",
  coup: "被政变",
};

export type CoupTurnReactionKind = "pass" | "challenge" | "block";

export interface CoupTurnReaction {
  seat: number;
  kind: CoupTurnReactionKind;
  as: CoupRole | null;
  say: string;
  note: string;
  forfeit: boolean;
  anomalies: string[];
  about: "claim" | "block";
}

export interface CoupTurnChallenge {
  challenger: number;
  target: number;
  /** Did the challenged seat actually hold the card? */
  holds: boolean;
  role: CoupRole | null;
}

export interface CoupTurnRecord {
  seq: number;
  turn: number;
  actor: number | null;
  action: CoupActionKind | null;
  role: CoupRole | null;
  target: number | null;
  say: string;
  note: string;
  /** Audience-only truth flag, computed by the reducer at claim time. */
  honest: boolean | null;
  paid: number;
  challengeable: boolean;
  blockable: boolean;
  reactions: CoupTurnReaction[];
  block: { seat: number; as: CoupRole; say: string; note: string } | null;
  challenge: CoupTurnChallenge | null;
  blockChallenge: CoupTurnChallenge | null;
  lost: Array<{ seat: number; role: CoupRole; cause: string; remaining: number }>;
  /** Seats that never produced a legal answer; their fallback is an accident. */
  forfeits: Array<{ seat: number; phase: string; anomalies: string[] }>;
  coins: Array<{ seat: number; coins: number; before: number | null }>;
  deck: number | null;
  voided: "challenge" | "block" | null;
  commentary: string | null;
  finished: boolean;
}

export function emptyTurn(turn = 0): CoupTurnRecord {
  return {
    seq: 0,
    turn,
    actor: null,
    action: null,
    role: null,
    target: null,
    say: "",
    note: "",
    honest: null,
    paid: 0,
    challengeable: false,
    blockable: false,
    reactions: [],
    block: null,
    challenge: null,
    blockChallenge: null,
    lost: [],
    forfeits: [],
    coins: [],
    deck: null,
    voided: null,
    commentary: null,
    finished: false,
  };
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRole(value: unknown): value is CoupRole {
  return typeof value === "string" && value in COUP_ROLE_ZH;
}

function isAction(value: unknown): value is CoupActionKind {
  return typeof value === "string" && value in COUP_ACTION_ZH;
}

/**
 * Fold one event into the draft. Returns the same object when the event does not
 * belong to a turn, so callers can keep identity-based memoisation cheap.
 */
export function applyTurnEvent(record: CoupTurnRecord, event: ArenaEvent): CoupTurnRecord {
  const p = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case "coup.action": {
      const actor = num(p.seat);
      const action = isAction(p.action) ? p.action : null;
      const role = isRole(p.role) ? p.role : null;
      const honest = typeof p.honest === "boolean" ? p.honest : null;
      return {
        ...record,
        seq: event.seq,
        turn: num(p.turn) ?? record.turn,
        actor,
        action,
        role,
        target: num(p.target),
        say: str(p.say),
        note: str(p.note),
        honest,
        paid: num(p.paid) ?? 0,
        challengeable: p.challengeable === true,
        blockable: p.blockable === true,
        // A new claim starts a new turn: drop anything the draft carried over.
        reactions: [],
        block: null,
        challenge: null,
        blockChallenge: null,
        lost: [],
        forfeits: [],
        coins: [],
        voided: null,
        commentary: null,
        finished: false,
      };
    }
    case "coup.reaction": {
      const seat = num(p.seat);
      if (seat === null) return record;
      const about = p.about === "block" ? "block" : "claim";
      const rawKind = str(p.kind, "pass");
      const kind: CoupTurnReactionKind =
        rawKind === "challenge" || rawKind === "block" ? rawKind : "pass";
      const next: CoupTurnReaction = {
        seat,
        kind,
        as: isRole(p.as) ? p.as : null,
        say: str(p.say),
        note: str(p.note),
        forfeit: p.forfeit === true,
        anomalies: Array.isArray(p.anomalies)
          ? p.anomalies.filter((x): x is string => typeof x === "string")
          : [],
        about,
      };
      const rest = record.reactions.filter((r) => !(r.seat === seat && r.about === about));
      return { ...record, reactions: [...rest, next] };
    }
    case "coup.block": {
      const seat = num(p.seat);
      const as = isRole(p.as) ? p.as : null;
      if (seat === null || !as) return record;
      return {
        ...record,
        block: { seat, as, say: str(p.say), note: str(p.note) },
      };
    }
    case "coup.challenge": {
      const challenger = num(p.challenger);
      const target = num(p.target);
      if (challenger === null || target === null) return record;
      const entry: CoupTurnChallenge = {
        challenger,
        target,
        holds: p.holds === true,
        role: isRole(p.role) ? p.role : null,
      };
      return p.about === "block"
        ? { ...record, blockChallenge: entry }
        : { ...record, challenge: entry };
    }
    case "coup.lost": {
      const seat = num(p.seat);
      const role = isRole(p.role) ? p.role : null;
      if (seat === null || !role) return record;
      const cause = str(p.cause, "");
      return {
        ...record,
        lost: [
          ...record.lost,
          { seat, role, cause, remaining: num(p.remaining) ?? 0 },
        ],
      };
    }
    case "coup.forfeit": {
      const seat = num(p.seat);
      if (seat === null) return record;
      const anomalies = Array.isArray(p.anomalies)
        ? p.anomalies.filter((x): x is string => typeof x === "string")
        : [];
      return {
        ...record,
        forfeits: [...record.forfeits, { seat, phase: str(p.phase, ""), anomalies }],
      };
    }
    case "coup.coins": {
      const rows = Array.isArray(p.coins) ? p.coins : [];
      const next: CoupTurnRecord["coins"] = [];
      for (const raw of rows) {
        const row = (raw ?? {}) as Record<string, unknown>;
        const seat = num(row.seat);
        const coins = num(row.coins);
        if (seat === null || coins === null) continue;
        next.push({ seat, coins, before: num(row.before) });
      }
      // Every balance change is kept in order: a pay followed by a refund reads
      // as "5 → 2" then "2 → 5", not as a silent net zero.
      return next.length === 0 ? record : { ...record, coins: [...record.coins, ...next] };
    }
    case "coup.result": {
      const voided = str(p.voided, "");
      if (voided !== "challenge" && voided !== "block") return record;
      return { ...record, voided };
    }
    case "coup.exchange": {
      const deck = num(p.deck);
      return deck === null ? record : { ...record, deck };
    }
    case "coup.turn": {
      const deck = num(p.deck);
      return deck === null ? record : { ...record, deck };
    }
    case "coup.finished": {
      return { ...record, finished: true };
    }
    default:
      return record;
  }
}

export type CoupTurnOutcome = "pending" | "resolved" | "blocked" | "voided" | "challenge_reversed";

export function turnOutcome(record: CoupTurnRecord): CoupTurnOutcome {
  if (record.action === null || record.actor === null) return "pending";
  if (record.blockChallenge?.holds === true) return "blocked";
  if (record.blockChallenge?.holds === false) return "resolved";
  if (record.challenge) return record.challenge.holds ? "challenge_reversed" : "voided";
  if (record.voided === "block") return "blocked";
  if (record.voided === "challenge") return "voided";
  return "resolved";
}

export function isBluff(record: CoupTurnRecord): boolean {
  return record.role !== null && record.honest === false;
}

export interface CoupTurnNarrative {
  /** `3 号 → 1 号 · 偷窃（队长）` */
  claim: string;
  /** One short outcome phrase, always visible even when the body scrolls. */
  headline: string;
  /** `他手上没有队长——诈唬` */
  truth: string;
  /** `「……」` or `（沉默）` */
  say: string;
  reactions: Array<{ seat: number; kind: CoupTurnReactionKind; text: string; note: string }>;
  forfeits: string[];
  results: string[];
}

export const COUP_ANOMALY_ZH: Record<string, string> = {
  no_submission: "没有交出 JSON",
  invalid_move: "动作不合法",
  invalid_reaction: "反应不合法",
  invalid_block: "阻挡不合法",
  no_reaction: "没有表态",
  no_flip: "没有选牌",
  no_exchange: "没有选牌换牌",
  no_protocol_markers: "没有按协议输出",
  missing_note: "缺少自述",
  missing_api_key: "没有可用密钥",
  stream_stalled: "输出中断",
  stalled: "输出中断",
  call_timeout: "调用超时",
  thinking_loop: "输出打转",
  thinking_too_long: "思考过长",
};

function roleOf(role: CoupRole | null): string {
  return role ? COUP_ROLE_ZH[role] : "";
}

function seatTag(seat: number | null): string {
  return seat === null ? "？号" : `${seat + 1} 号`;
}

function reactionVerb(kind: CoupTurnReactionKind): string {
  if (kind === "challenge") return "质疑";
  if (kind === "block") return "阻挡";
  return "放过";
}

/**
 * The audience-facing fact sheet. Everything here is derived from the record;
 * no model is involved, so it is always available, even with commentary off.
 */
export function describeTurn(
  record: CoupTurnRecord,
  options: { pending?: boolean } = {},
): CoupTurnNarrative {
  const actor = seatTag(record.actor);
  const action = record.action ? COUP_ACTION_ZH[record.action] : "行动";
  const target = record.target !== null ? `→ ${seatTag(record.target)}` : "";
  const role = record.role ? `（${roleOf(record.role)}）` : "";
  const claim = [actor, target, `· ${action}${role}`].filter(Boolean).join(" ");

  let truth = "基础行动，不需要身份";
  if (record.role) {
    if (record.honest === true) truth = `他手上真的有${roleOf(record.role)}`;
    else if (record.honest === false) truth = `他手上没有${roleOf(record.role)}——诈唬`;
    else truth = `他宣称自己有${roleOf(record.role)}`;
  }

  const reactions = record.reactions.map((r) => ({
    seat: r.seat,
    kind: r.kind,
    text: `${seatTag(r.seat)} ${reactionVerb(r.kind)}${r.as ? `（${roleOf(r.as)}）` : ""}${
      r.say ? `：「${r.say}」` : ""
    }${r.forfeit ? "（弃权）" : ""}`,
    note: r.note,
  }));

  const results: string[] = [];
  let headline = "结算完毕";
  if (record.blockChallenge?.holds === true) headline = "阻挡成立，行动失败";
  else if (record.challenge) {
    headline = record.challenge.holds
      ? `质疑失败，${seatTag(record.challenge.challenger)} 掉一条命`
      : "质疑成立，行动作废";
  } else if (record.lost.length > 0) {
    headline = `${seatTag(record.lost[0]!.seat)} 掉一条命`;
  } else {
    const changed = record.coins.filter((c) => c.before !== null && c.before !== c.coins);
    if (changed.length > 0) {
      const first = changed[0]!;
      headline = `${seatTag(first.seat)} ${first.before} → ${first.coins} 枚`;
    } else if (record.action === "income") {
      headline = "拿 1 枚";
    }
  }

  const forfeits = record.forfeits.map((f) => {
    const reason = f.anomalies.map((a) => COUP_ANOMALY_ZH[a] ?? a).join("、") || "未知原因";
    const fallback =
      f.phase === "action_select"
        ? "这一手按「收入」处理"
        : f.phase === "influence_lose"
          ? "自动翻开第一张"
          : f.phase === "exchange_pick"
            ? "保留原手牌"
            : "按「放过」处理";
    return `${seatTag(f.seat)} 没有交出合法答案（${reason}），${fallback}`;
  });

  if (record.block) {
    results.push(
      `${seatTag(record.block.seat)} 用${roleOf(record.block.as)}挡这一手${
        record.block.say ? `：「${record.block.say}」` : ""
      }`,
    );
  }
  if (record.challenge) {
    const { challenger, target: who, holds, role: r } = record.challenge;
    results.push(
      holds
        ? `质疑失败：${seatTag(who)} 亮出${roleOf(r)}，${seatTag(challenger)} 掉一条命`
        : `质疑成立：${seatTag(who)} 亮不出${roleOf(r)}，行动作废，已付金币退回，${seatTag(who)} 掉一条命`,
    );
  }
  if (record.blockChallenge) {
    const { challenger, target: who, holds, role: r } = record.blockChallenge;
    results.push(
      holds
        ? `质疑阻挡失败：${seatTag(who)} 亮出${roleOf(r)}，这一手被挡下`
        : `质疑阻挡成立：${seatTag(who)} 亮不出${roleOf(r)}，阻挡失效，行动照常生效`,
    );
  }
  for (const lost of record.lost) {
    const cause = COUP_CAUSE_ZH[lost.cause] ?? "失去一条命";
    results.push(`${seatTag(lost.seat)} 翻开${roleOf(lost.role)}（${cause}），剩 ${lost.remaining} 条命`);
  }
  for (const row of record.coins) {
    if (row.before === null || row.before === row.coins) continue;
    results.push(`${seatTag(row.seat)} ${row.before} → ${row.coins} 枚`);
  }

  if (results.length === 0) {
    results.push(
      options.pending
        ? "还在等这一步走完"
        : record.action === "income"
          ? `${actor} 拿 1 枚`
          : "这一手结算完毕",
    );
  }

  return {
    claim,
    headline,
    truth,
    say: record.say ? `「${record.say}」` : "（沉默）",
    reactions,
    forfeits,
    results,
  };
}

/* ── the same turn, unrolled into an ordered timeline ───────────────── */

export interface CoupTurnStep {
  kind: "claim" | "reaction" | "block" | "challenge" | "block_challenge" | "lost" | "coins" | "forfeit";
  seat: number | null;
  /** Gutter label: 宣称 / 放过 / 质疑 / 阻挡 / 掉命 / 金币 / 弃权. */
  label: string;
  /** One-line fact, already in Chinese. */
  text: string;
  /** The seat's audience note for this step, when the model wrote one. */
  note: string;
}

function forfeitFallback(phase: string): string {
  if (phase === "action_select") return "这一手按「收入」处理";
  if (phase === "influence_lose") return "自动翻开第一张";
  if (phase === "exchange_pick") return "保留原手牌";
  return "按「放过」处理";
}

/**
 * Unroll one turn into the order it actually happened. The view model and the
 * turn detail panel both read this, so "what happened first" can never differ
 * between the timeline card and the panel behind it.
 */
export function describeTurnSteps(record: CoupTurnRecord): CoupTurnStep[] {
  const steps: CoupTurnStep[] = [];
  if (record.actor === null) return steps;

  const action = record.action ? COUP_ACTION_ZH[record.action] : "行动";
  const role = record.role ? `（${roleOf(record.role)}）` : "";
  const target = record.target !== null ? ` → ${seatTag(record.target)}` : "";
  steps.push({
    kind: "claim",
    seat: record.actor,
    label: "宣称",
    text: `${seatTag(record.actor)}${target} 打${action}${role}${
      record.paid > 0 ? `，先付 ${record.paid} 枚` : ""
    }`,
    note: record.note,
  });

  for (const f of record.forfeits) {
    const reason = f.anomalies.map((a) => COUP_ANOMALY_ZH[a] ?? a).join("、") || "未知原因";
    steps.push({
      kind: "forfeit",
      seat: f.seat,
      label: "弃权",
      text: `${seatTag(f.seat)} 没有交出合法答案（${reason}），${forfeitFallback(f.phase)}`,
      note: "",
    });
  }

  // Answers to the claim. A block appears twice in the stream — once as a
  // reaction and once as `coup.block` — so the block gets its own step and the
  // reaction list skips it.
  for (const r of record.reactions.filter((x) => x.about === "claim" && x.kind !== "block")) {
    steps.push({
      kind: "reaction",
      seat: r.seat,
      label: reactionVerb(r.kind),
      text: `${seatTag(r.seat)} ${reactionVerb(r.kind)}${r.say ? `：「${r.say}」` : "，没有出声"}${
        r.forfeit ? "（弃权）" : ""
      }`,
      note: r.note,
    });
  }

  if (record.block) {
    steps.push({
      kind: "block",
      seat: record.block.seat,
      label: "阻挡",
      text: `${seatTag(record.block.seat)} 用${roleOf(record.block.as)}挡下这一手${
        record.block.say ? `：「${record.block.say}」` : ""
      }`,
      note: record.block.note,
    });
  }

  if (record.challenge) {
    const { challenger, target: who, holds, role: claimed } = record.challenge;
    steps.push({
      kind: "challenge",
      seat: challenger,
      label: "结质疑",
      text: holds
        ? `质疑失败：${seatTag(who)} 亮出${roleOf(claimed)}，${seatTag(challenger)} 掉一条命`
        : `质疑成立：${seatTag(who)} 亮不出${roleOf(claimed)}，行动作废、已付金币退回，${seatTag(who)} 掉一条命`,
      note: "",
    });
  }

  for (const r of record.reactions.filter((x) => x.about === "block")) {
    steps.push({
      kind: "reaction",
      seat: r.seat,
      label: "质疑阻挡",
      text: `${seatTag(r.seat)} 不信这个阻挡${r.say ? `：「${r.say}」` : ""}`,
      note: r.note,
    });
  }

  if (record.blockChallenge) {
    const { challenger, target: who, holds, role: claimed } = record.blockChallenge;
    steps.push({
      kind: "block_challenge",
      seat: challenger,
      label: "结阻挡",
      text: holds
        ? `质疑阻挡失败：${seatTag(who)} 亮出${roleOf(claimed)}，这一手被挡下`
        : `质疑阻挡成立：${seatTag(who)} 亮不出${roleOf(claimed)}，阻挡失效，行动照常生效`,
      note: "",
    });
  }

  for (const lost of record.lost) {
    steps.push({
      kind: "lost",
      seat: lost.seat,
      label: "掉命",
      text: `${seatTag(lost.seat)} 翻开${roleOf(lost.role)}（${
        COUP_CAUSE_ZH[lost.cause] ?? "失去一条命"
      }），剩 ${lost.remaining} 条命`,
      note: "",
    });
  }

  for (const row of record.coins) {
    if (row.before === null || row.before === row.coins) continue;
    steps.push({
      kind: "coins",
      seat: row.seat,
      label: "金币",
      text: `${seatTag(row.seat)} ${row.before} → ${row.coins} 枚`,
      note: "",
    });
  }

  return steps;
}
