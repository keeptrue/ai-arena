/**
 * Post-game review for the nine-seat table. Pure: it reads the finished state and
 * the public event stream, builds the ballot packet, parses ballots and averages
 * them. No I/O, no provider calls, no clock.
 *
 * The review never changes a game fact. It only answers "who played this table
 * best", after every card is face up.
 */

import { repairJson } from "../parse";
import type { ArenaEvent } from "../types";
import { roleLabel } from "./blueprint";
import type {
  DeathCause,
  PublicEntry,
  WerewolfBlueprint,
  WerewolfCamp,
  WerewolfRoleId,
  WerewolfSeatState,
  WerewolfState,
} from "./types";

/* ── rules ─────────────────────────────────────────────────────────── */

export interface ReviewWeights {
  read: number;
  voice: number;
  craft: number;
  poise: number;
}

export interface ReviewRules {
  enabled: boolean;
  /** 0 = the self ballot is display-only. */
  selfWeight: number;
  /** The judge ballot is worth this many player ballots. */
  judgeVotes: number;
  trim: boolean;
  minBallots: number;
  weights: ReviewWeights;
  maxChronicleChars: number;
}

export const REVIEW_DIMENSIONS = ["read", "voice", "craft", "poise"] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const REVIEW_DIMENSION_META: Record<
  ReviewDimension,
  { label: string; hint: string; anchor: string }
> = {
  read: {
    label: "判断",
    hint: "信息利用、身份判断、刀口与票型解读",
    anchor:
      "9–10 关键轮次判断正确，并能用当时的公开信息说清依据；5–6 中规中矩，跟随主流；1–2 多次跟错票、站错边，或全程反指。",
  },
  voice: {
    label: "表达",
    hint: "发言结构、说服力、悍跳/对跳/抗推，是否带动票型",
    anchor:
      "9–10 发言能定调，票型因他改变，谎言结构完整、经得起追问；5–6 表达清楚但不改变局势；1–2 发言含糊、矛盾多，或被轻易问穿。",
  },
  craft: {
    label: "操作",
    hint: "验人、用药、开枪、刀法、投票落点、狼队协同",
    anchor:
      "9–10 每一手都打在关键点、时机正确；5–6 按部就班，无明显失误也无亮点；1–2 关键技能空放、误伤、刀偏或毒好人。",
  },
  poise: {
    label: "抗压",
    hint: "被集火、被查杀、被悍跳时的稳定性；不挂机、不摆烂",
    anchor:
      "9–10 压力下仍能稳定输出，能把局面拉回来；5–6 正常波动；1–2 明显情绪化、复读、弃权或破坏对局。",
  },
};

export const DEFAULT_REVIEW_RULES: ReviewRules = {
  enabled: true,
  selfWeight: 0,
  judgeVotes: 2,
  trim: true,
  minBallots: 4,
  weights: { read: 0.35, voice: 0.3, craft: 0.25, poise: 0.1 },
  maxChronicleChars: 32_000,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeWeights(raw?: Partial<ReviewWeights>): ReviewWeights {
  const merged = { ...DEFAULT_REVIEW_RULES.weights, ...(raw ?? {}) };
  const sum = merged.read + merged.voice + merged.craft + merged.poise;
  if (!Number.isFinite(sum) || sum <= 0) return { ...DEFAULT_REVIEW_RULES.weights };
  return {
    read: merged.read / sum,
    voice: merged.voice / sum,
    craft: merged.craft / sum,
    poise: merged.poise / sum,
  };
}

/** Merge the blueprint's optional overrides with the house defaults. */
export function resolveReviewRules(spec: WerewolfBlueprint): ReviewRules {
  const cfg = spec.review ?? {};
  return {
    enabled: cfg.enabled ?? DEFAULT_REVIEW_RULES.enabled,
    selfWeight: clamp(cfg.selfWeight ?? DEFAULT_REVIEW_RULES.selfWeight, 0, 1),
    judgeVotes: Math.round(clamp(cfg.judgeVotes ?? DEFAULT_REVIEW_RULES.judgeVotes, 0, 3)),
    trim: cfg.trim ?? DEFAULT_REVIEW_RULES.trim,
    minBallots: Math.round(clamp(cfg.minBallots ?? DEFAULT_REVIEW_RULES.minBallots, 1, 9)),
    weights: normalizeWeights(cfg.weights),
    maxChronicleChars: DEFAULT_REVIEW_RULES.maxChronicleChars,
  };
}

/* ── rater plan ────────────────────────────────────────────────────── */

export interface ReviewRaterPlan {
  /** Who votes: every seat, then the judge ballot when one was frozen. */
  raters: Array<number | "judge">;
  /** The seat the judge also played, when the frozen judge is one of the nine models. */
  judgeSeat: number | null;
}

/**
 * Who votes in one review attempt.
 *
 * A judge may also sit at this table, so it keeps both ballots: the seat's self
 * ballot (weighted by `selfWeight`) and the judge ballot (weighted by
 * `judgeVotes`). The plan therefore never drops the judge ballot; `judgeSeat`
 * only lets the prompt tell the referee which seat it is grading itself.
 */
export function planReviewRaters(
  seatModels: ReadonlyMap<number, { providerId: string; modelId: string }>,
  judge: { providerId: string; modelId: string } | null,
): ReviewRaterPlan {
  const seats = [...seatModels.keys()].sort((a, b) => a - b);
  let judgeSeat: number | null = null;
  if (judge) {
    for (const seat of seats) {
      const model = seatModels.get(seat);
      if (model && model.providerId === judge.providerId && model.modelId === judge.modelId) {
        judgeSeat = seat;
        break;
      }
    }
  }
  const raters: Array<number | "judge"> = judge ? [...seats, "judge"] : seats;
  return { raters, judgeSeat };
}

/* ── ballot types ──────────────────────────────────────────────────── */

export interface ReviewScoreRow {
  /** 0-based; prompts use 1–9. */
  seat: number;
  read: number;
  voice: number;
  craft: number;
  poise: number;
  comment?: string;
}

export interface ReviewBallotBody {
  scores: ReviewScoreRow[];
  mvp: number | null;
  bestSpeech: number | null;
  bestDeception: number | null;
  summary: string;
}

export interface ReviewBallot extends ReviewBallotBody {
  rater: number | "judge";
}

export interface ReviewSeatResult {
  seat: number;
  read: number;
  voice: number;
  craft: number;
  poise: number;
  total: number;
  judgeTotal: number | null;
  selfTotal: number | null;
  mvpVotes: number;
  bestSpeechVotes: number;
  bestDeceptionVotes: number;
  rank: number;
  tied: boolean;
  ballots: number;
  dropped: number[];
}

export interface ReviewVerdict {
  attempt: number;
  weights: ReviewWeights;
  ranking: ReviewSeatResult[];
  mvp: number | null;
  bestSpeech: number | null;
  bestDeception: number | null;
  provisional: boolean;
  judge: boolean;
  raters: { players: number; judge: boolean; missing: Array<number | "judge"> };
  usage?: { calls: number; tokens: number; cached?: number };
  reason?: string;
}

/* ── packet ────────────────────────────────────────────────────────── */

export interface ReviewFactsSeat {
  seat: number;
  role: WerewolfRoleId;
  camp: WerewolfCamp;
  alive: boolean;
  death: { day: number; cause: DeathCause } | null;
  votesCast: Array<{ day: number; target: number | "abstain"; pk: boolean }>;
  votesAgainst: number;
  speechCount: number;
  lastWords: string | null;
  forfeits: number;
  afk: boolean;
}

export interface ReviewFactsNight {
  day: number;
  kill: number | null;
  saved: boolean;
  poison: number | null;
  deaths: Array<{ seat: number; cause: DeathCause }>;
  seer: { seat: number; target: number; result: "wolf" | "good" } | null;
  wolfTalk: Array<{ seat: number; text: string }>;
}

export interface ReviewFactsVote {
  day: number;
  counts: Record<number, number>;
  votes: Record<number, number | "abstain">;
  exiled: number | null;
  tie: number[];
  pk: boolean;
}

export interface ReviewFacts {
  winner: WerewolfCamp | null;
  endReason: string;
  days: number;
  seats: ReviewFactsSeat[];
  nights: ReviewFactsNight[];
  votes: ReviewFactsVote[];
  hunterShots: Array<{ day: number; seat: number; target: number | null }>;
  selfDestructs: Array<{ day: number; seat: number }>;
  checks: Array<{ day: number; seat: number; target: number; result: "wolf" | "good" }>;
  witch: { saves: Array<{ day: number; target: number }>; poisons: Array<{ day: number; target: number }> };
}

export interface ReviewPacket {
  name: string;
  briefing: string;
  winner: WerewolfCamp | null;
  endReason: string;
  days: number;
  seats: Array<{
    seat: number;
    role: WerewolfRoleId;
    camp: WerewolfCamp;
    alive: boolean;
    death: { day: number; cause: DeathCause } | null;
  }>;
  facts: ReviewFacts;
  factsText: string;
  chronicle: string;
}

/* ── payload helpers ───────────────────────────────────────────────── */

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function seatOfPayload(value: unknown): number | null {
  const n = num(value, Number.NaN);
  return Number.isInteger(n) ? n : null;
}

function voteMap(raw: unknown): Record<number, number | "abstain"> {
  const out: Record<number, number | "abstain"> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const seat = Number(key);
    if (!Number.isInteger(seat)) continue;
    out[seat] = value === "abstain" ? "abstain" : typeof value === "number" ? value : "abstain";
  }
  return out;
}

function countMap(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const seat = Number(key);
    if (!Number.isInteger(seat)) continue;
    out[seat] = num(value, 0);
  }
  return out;
}

function deathCause(value: unknown): DeathCause {
  return value === "poison" || value === "vote" || value === "hunter" || value === "self_destruct"
    ? value
    : "wolf";
}

/* ── facts ─────────────────────────────────────────────────────────── */

export function collectFacts(state: WerewolfState, events: ArenaEvent[]): ReviewFacts {
  const seats: ReviewFactsSeat[] = state.seats
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((s) => ({
      seat: s.seat,
      role: s.role,
      camp: s.camp,
      alive: s.alive,
      death: s.death,
      votesCast: [],
      votesAgainst: 0,
      speechCount: 0,
      lastWords: s.lastWords,
      forfeits: 0,
      afk: s.afk,
    }));
  const bySeat = new Map(seats.map((s) => [s.seat, s]));
  const nights = new Map<number, ReviewFactsNight>();
  const votes: ReviewFactsVote[] = [];
  const hunterShots: ReviewFacts["hunterShots"] = [];
  const selfDestructs: ReviewFacts["selfDestructs"] = [];
  const checks: ReviewFacts["checks"] = [];

  const night = (day: number): ReviewFactsNight => {
    let n = nights.get(day);
    if (!n) {
      n = { day, kill: null, saved: false, poison: null, deaths: [], seer: null, wolfTalk: [] };
      nights.set(day, n);
    }
    return n;
  };

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case "speech": {
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) {
          const row = bySeat.get(seat);
          if (row) row.speechCount += 1;
        }
        break;
      }
      case "vote.tally": {
        const day = num(p.day, 0);
        const map = voteMap(p.votes);
        const record: ReviewFactsVote = {
          day,
          counts: countMap(p.counts),
          votes: map,
          exiled: p.exiled === null || p.exiled === undefined ? null : num(p.exiled, 0),
          tie: Array.isArray(p.tie) ? (p.tie as unknown[]).map((n) => num(n, 0)) : [],
          pk: p.pk === true,
        };
        votes.push(record);
        for (const [from, target] of Object.entries(map)) {
          const fromSeat = Number(from);
          const row = bySeat.get(fromSeat);
          if (row) row.votesCast.push({ day, target, pk: record.pk });
          if (typeof target === "number") {
            const victim = bySeat.get(target);
            if (victim) victim.votesAgainst += 1;
          }
        }
        break;
      }
      case "night.resolved": {
        const day = num(p.day, 0);
        const n = night(day);
        n.kill = p.killTarget === null || p.killTarget === undefined ? null : num(p.killTarget, 0);
        n.saved = p.saved === true;
        n.poison = p.poisonTarget === null || p.poisonTarget === undefined ? null : num(p.poisonTarget, 0);
        const deaths = Array.isArray(p.deaths) ? p.deaths : [];
        n.deaths = deaths.map((raw) => {
          const item = raw as Record<string, unknown>;
          return { seat: num(item.seat, 0), cause: deathCause(item.cause) };
        });
        break;
      }
      case "dawn": {
        const day = num(p.day, 0);
        const n = night(day);
        if (n.deaths.length === 0 && Array.isArray(p.deaths)) {
          n.deaths = (p.deaths as unknown[]).map((raw) => {
            const seat = num(raw, 0);
            return { seat, cause: bySeat.get(seat)?.death?.cause ?? "wolf" };
          });
        }
        break;
      }
      case "seer.check": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        const target = seatOfPayload(p.target);
        const result = p.result === "wolf" ? "wolf" : "good";
        if (seat !== null && target !== null) {
          const check = { day, seat, target, result } as const;
          checks.push(check);
          night(day).seer = check;
        }
        break;
      }
      case "wolf.chat": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) night(day).wolfTalk.push({ seat, text: str(p.text) });
        break;
      }
      case "hunter.shot": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) {
          hunterShots.push({
            day,
            seat,
            target: p.target === null || p.target === undefined ? null : num(p.target, 0),
          });
        }
        break;
      }
      case "self_destruct": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) selfDestructs.push({ day, seat });
        break;
      }
      case "last_words": {
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) {
          const row = bySeat.get(seat);
          if (row) row.lastWords = str(p.text);
        }
        break;
      }
      case "seat.forfeit": {
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) {
          const row = bySeat.get(seat);
          if (row) row.forfeits += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  const sortedNights = [...nights.values()].sort((a, b) => a.day - b.day);
  const witch = {
    saves: sortedNights
      .filter((n) => n.saved && n.kill !== null)
      .map((n) => ({ day: n.day, target: n.kill as number })),
    poisons: sortedNights
      .filter((n) => n.poison !== null)
      .map((n) => ({ day: n.day, target: n.poison as number })),
  };
  const maxDay = Math.max(
    1,
    state.day,
    ...sortedNights.map((n) => n.day),
    ...votes.map((v) => v.day),
  );

  return {
    winner: state.winner,
    endReason: state.endReason ?? "",
    days: maxDay,
    seats,
    nights: sortedNights,
    votes,
    hunterShots,
    selfDestructs,
    checks,
    witch,
  };
}

/* ── text rendering ────────────────────────────────────────────────── */

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function seatLabel(seat: number): string {
  return `${seat + 1}号`;
}

function roleOf(state: WerewolfState, seat: number): WerewolfRoleId {
  return state.seats.find((s) => s.seat === seat)?.role ?? "villager";
}

function campLabel(camp: WerewolfCamp): string {
  return camp === "wolf" ? "狼人" : "好人";
}

export function renderFacts(state: WerewolfState, facts: ReviewFacts): string {
  const roleText = state.seats
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((s) => `${seatLabel(s.seat)}${roleLabel(state.spec, s.role)}（${campLabel(s.camp)}）`)
    .join("、");

  const actions = new Map<number, string[]>();
  const addAction = (seat: number | null, text: string) => {
    if (seat === null) return;
    const list = actions.get(seat) ?? [];
    list.push(text);
    actions.set(seat, list);
  };
  for (const check of facts.checks) {
    addAction(check.seat, `第${check.day}夜验${seatLabel(check.target)}=${check.result === "wolf" ? "狼" : "好人"}`);
  }
  for (const save of facts.witch.saves) {
    const witchSeat = state.seats.find((s) => s.role === "witch")?.seat ?? null;
    addAction(witchSeat, `第${save.day}夜用解药救${seatLabel(save.target)}`);
  }
  for (const poison of facts.witch.poisons) {
    const witchSeat = state.seats.find((s) => s.role === "witch")?.seat ?? null;
    addAction(witchSeat, `第${poison.day}夜用毒药毒${seatLabel(poison.target)}`);
  }
  for (const shot of facts.hunterShots) {
    addAction(
      shot.seat,
      shot.target === null ? `第${shot.day}天未开枪` : `第${shot.day}天开枪带走${seatLabel(shot.target)}`,
    );
  }
  for (const boom of facts.selfDestructs) {
    addAction(boom.seat, `第${boom.day}天自爆`);
  }

  const table = [
    "| 座位 | 身份 | 阵营 | 结局 | 投出的票 | 被投 | 关键动作 |",
    "|---|---|---|---|---|---|---|",
    ...facts.seats.map((s) => {
      const voteText = s.votesCast.length
        ? s.votesCast
            .map((v) => `第${v.day}天${v.pk ? "PK" : ""}→${v.target === "abstain" ? "弃票" : seatLabel(v.target)}`)
            .join("、")
        : "—";
      const actionText = (actions.get(s.seat) ?? []).join("；") || "—";
      const deathText = s.alive
        ? "存活"
        : s.death
          ? `第${s.death.day}天出局（${deathLabel(s.death.cause)}）`
          : "出局";
      return `| ${seatLabel(s.seat)} | ${roleLabel(state.spec, s.role)} | ${campLabel(s.camp)} | ${deathText} | ${voteText} | ${s.votesAgainst} | ${actionText} |`;
    }),
  ].join("\n");

  const nightLines = facts.nights.length
    ? facts.nights.map((n) => {
        const parts = [
          n.kill === null ? "狼队空刀" : `狼队刀${seatLabel(n.kill)}`,
          n.saved ? "女巫用解药救回" : "",
          n.poison !== null ? `女巫毒${seatLabel(n.poison)}` : "",
          n.seer
            ? `预言家${seatLabel(n.seer.seat)}验${seatLabel(n.seer.target)}=${n.seer.result === "wolf" ? "狼" : "好人"}`
            : "",
          n.deaths.length
            ? `出局：${n.deaths.map((d) => `${seatLabel(d.seat)}（${deathLabel(d.cause)}）`).join("、")}`
            : "平安夜",
        ].filter(Boolean);
        const talk = n.wolfTalk.length
          ? `\n  - 狼队低语：${n.wolfTalk.map((t) => `${seatLabel(t.seat)}「${clip(t.text, 120)}」`).join("；")}`
          : "";
        return `- 第${n.day}夜：${parts.join("；")}${talk}`;
      })
    : ["- （没有可复盘的夜间记录）"];

  const voteLines = facts.votes.length
    ? facts.votes.flatMap((v) => {
        const counts =
          Object.entries(v.counts)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([seat, n]) => `${seatLabel(Number(seat))}${n}票`)
            .join("，") || "无人得票";
        const verdict =
          v.exiled !== null
            ? `${seatLabel(v.exiled)}被放逐`
            : v.tie.length
              ? `平票：${v.tie.map(seatLabel).join("、")}`
              : "无人出局";
        const detail =
          Object.entries(v.votes)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([from, to]) => `${seatLabel(Number(from))}→${to === "abstain" ? "弃票" : seatLabel(Number(to))}`)
            .join("，") || "无票";
        return [
          `- 第${v.day}天${v.pk ? "（PK 重投）" : ""}：${counts}；${verdict}`,
          `  - 票型：${detail}`,
        ];
      })
    : ["- （没有投票记录）"];

  const winnerText =
    facts.winner === null
      ? `无胜者（${facts.endReason || "未知原因"}）`
      : `${facts.winner === "wolf" ? "狼人阵营" : "好人阵营"}胜（${facts.endReason || "未知原因"}）`;

  return [
    `## 身份与结局`,
    roleText,
    `- 结果：${winnerText}`,
    `- 天数：${facts.days} 天`,
    "",
    `## 逐座位账面`,
    table,
    "",
    `## 夜间账本`,
    ...nightLines,
    "",
    `## 票型账本`,
    ...voteLines,
  ].join("\n");
}

function deathLabel(cause: DeathCause): string {
  switch (cause) {
    case "wolf":
      return "狼刀";
    case "poison":
      return "毒药";
    case "vote":
      return "放逐";
    case "hunter":
      return "猎人枪";
    case "self_destruct":
      return "自爆";
    default:
      return cause;
  }
}

function chronicleBlock(day: number): string[] {
  return [`## 第${day}天`];
}

export function renderChronicle(state: WerewolfState, events: ArenaEvent[], maxChars = 32_000): string {
  const blocks = new Map<number, string[]>();
  const push = (day: number, line: string) => {
    const list = blocks.get(day) ?? [];
    list.push(line);
    blocks.set(day, list);
  };

  const roleText = state.seats
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((s) => `${seatLabel(s.seat)}${roleLabel(state.spec, s.role)}`)
    .join("、");
  const header = [`## 赛后翻牌`, roleText].join("\n");

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case "night.resolved": {
        const day = num(p.day, 0);
        const parts = [
          p.killTarget === null || p.killTarget === undefined
            ? "狼队空刀"
            : `狼队刀${seatLabel(num(p.killTarget, 0))}`,
          p.saved === true ? "女巫用解药救回" : "",
          p.poisonTarget === null || p.poisonTarget === undefined
            ? ""
            : `女巫毒${seatLabel(num(p.poisonTarget, 0))}`,
        ].filter(Boolean);
        push(day, `第${day}夜：${parts.join("；")}`);
        break;
      }
      case "wolf.chat": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) push(day, `狼队低语 · ${seatLabel(seat)}：${clip(str(p.text), 120)}`);
        break;
      }
      case "seer.check": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        const target = seatOfPayload(p.target);
        if (seat !== null && target !== null) {
          push(
            day,
            `预言家${seatLabel(seat)}验${seatLabel(target)}：${p.result === "wolf" ? "狼人" : "好人"}`,
          );
        }
        break;
      }
      case "dawn": {
        const day = num(p.day, 0);
        const deaths = Array.isArray(p.deaths) ? (p.deaths as unknown[]).map((n) => num(n, 0)) : [];
        push(
          day,
          deaths.length
            ? `第${day}天 天亮：${deaths.map((n) => `${seatLabel(n)}（${roleLabel(state.spec, roleOf(state, n))}）`).join("、")}出局`
            : `第${day}天 天亮：平安夜`,
        );
        break;
      }
      case "speech": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) {
          push(day, `${seatLabel(seat)}${p.pk === true ? "（PK）" : ""}发言：${clip(str(p.text), 400)}`);
        }
        break;
      }
      case "self_destruct": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) push(day, `${seatLabel(seat)}自爆（${roleLabel(state.spec, roleOf(state, seat))}）`);
        break;
      }
      case "vote.tally": {
        const day = num(p.day, 0);
        const counts = countMap(p.counts);
        const votes = voteMap(p.votes);
        const countText =
          Object.entries(counts)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([seat, n]) => `${seatLabel(Number(seat))}${n}票`)
            .join("，") || "无人得票";
        const verdict =
          p.exiled !== null && p.exiled !== undefined
            ? `${seatLabel(num(p.exiled, 0))}被放逐`
            : Array.isArray(p.tie) && p.tie.length
              ? `平票：${(p.tie as unknown[]).map((n) => seatLabel(num(n, 0))).join("、")}`
              : "无人出局";
        const detail =
          Object.entries(votes)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([from, to]) => `${seatLabel(Number(from))}→${to === "abstain" ? "弃票" : seatLabel(Number(to))}`)
            .join("，") || "无票";
        push(day, `第${day}天${p.pk === true ? "（PK 重投）" : ""}投票：${countText}；${verdict}；票型：${detail}`);
        break;
      }
      case "exile": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) push(day, `${seatLabel(seat)}被放逐（${roleLabel(state.spec, roleOf(state, seat))}）`);
        break;
      }
      case "no_exile": {
        const day = num(p.day, 0);
        push(day, `第${day}天：${p.reason === "tie" ? "平票，无人出局" : "无人投票，无人出局"}`);
        break;
      }
      case "hunter.shot": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) {
          push(
            day,
            p.target === null || p.target === undefined
              ? `${seatLabel(seat)}猎人未开枪`
              : `${seatLabel(seat)}猎人开枪带走${seatLabel(num(p.target, 0))}`,
          );
        }
        break;
      }
      case "last_words": {
        const day = num(p.day, 0);
        const seat = seatOfPayload(p.seat ?? event.seat);
        if (seat !== null) push(day, `${seatLabel(seat)}遗言：${clip(str(p.text), 200) || "（无言）"}`);
        break;
      }
      default:
        break;
    }
  }

  if (blocks.size === 0) return chronicleFromPublicLog(state, maxChars);

  const ordered = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, lines]) => [chronicleBlock(day)[0], ...lines].join("\n"));

  const footer =
    state.winner === null
      ? `## 终局\n无胜者（${state.endReason ?? "未知"}）`
      : `## 终局\n${state.winner === "wolf" ? "狼人阵营" : "好人阵营"}胜（${state.endReason ?? "未知"}）`;

  return capChronicle(header, ordered, footer, maxChars);
}

function capChronicle(header: string, blocks: string[], footer: string, maxChars: number): string {
  const kept = [...blocks];
  let dropped = 0;
  const build = () =>
    [
      header,
      dropped ? `（较早的 ${dropped} 天记录已省略）` : "",
      ...kept,
      footer,
    ]
      .filter(Boolean)
      .join("\n\n");

  let text = build();
  while (text.length > maxChars && kept.length > 1) {
    kept.shift();
    dropped += 1;
    text = build();
  }
  if (text.length > maxChars) return text.slice(text.length - maxChars);
  return text;
}

function chronicleFromPublicLog(state: WerewolfState, maxChars: number): string {
  const blocks = new Map<number, string[]>();
  const push = (day: number, line: string) => {
    const list = blocks.get(day) ?? [];
    list.push(line);
    blocks.set(day, list);
  };
  const roleText = state.seats
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((s) => `${seatLabel(s.seat)}${roleLabel(state.spec, s.role)}`)
    .join("、");
  for (const entry of state.publicLog) {
    renderPublicEntry(state, entry, push);
  }
  const ordered = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, lines]) => [`## 第${day}天`, ...lines].join("\n"));
  const footer =
    state.winner === null
      ? `## 终局\n无胜者（${state.endReason ?? "未知"}）`
      : `## 终局\n${state.winner === "wolf" ? "狼人阵营" : "好人阵营"}胜（${state.endReason ?? "未知"}）`;
  return capChronicle(`## 赛后翻牌\n${roleText}`, ordered, footer, maxChars);
}

function renderPublicEntry(
  state: WerewolfState,
  entry: PublicEntry,
  push: (day: number, line: string) => void,
): void {
  switch (entry.kind) {
    case "dawn":
      push(
        entry.day,
        entry.deaths.length
          ? `第${entry.day}天 天亮：${entry.deaths.map((n) => `${seatLabel(n)}（${roleLabel(state.spec, roleOf(state, n))}）`).join("、")}出局`
          : `第${entry.day}天 天亮：平安夜`,
      );
      break;
    case "speech":
      push(entry.day, `${seatLabel(entry.seat)}${entry.pk ? "（PK）" : ""}发言：${clip(entry.text, 400)}`);
      break;
    case "self_destruct":
      push(entry.day, `${seatLabel(entry.seat)}自爆`);
      break;
    case "vote": {
      const counts =
        Object.entries(entry.counts)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([seat, n]) => `${seatLabel(Number(seat))}${n}票`)
          .join("，") || "无人得票";
      const verdict =
        entry.exiled !== null
          ? `${seatLabel(entry.exiled)}被放逐`
          : entry.tie.length
            ? `平票：${entry.tie.map(seatLabel).join("、")}`
            : "无人出局";
      push(entry.day, `第${entry.day}天投票：${counts}；${verdict}`);
      break;
    }
    case "exile":
      push(entry.day, `${seatLabel(entry.seat)}被放逐（${roleLabel(state.spec, roleOf(state, entry.seat))}）`);
      break;
    case "no_exile":
      push(entry.day, `第${entry.day}天：${entry.reason === "tie" ? "平票，无人出局" : "无人投票，无人出局"}`);
      break;
    case "hunter_shot":
      push(
        entry.day,
        entry.target === null
          ? `${seatLabel(entry.seat)}猎人未开枪`
          : `${seatLabel(entry.seat)}猎人开枪带走${seatLabel(entry.target)}`,
      );
      break;
    case "last_words":
      push(entry.day, `${seatLabel(entry.seat)}遗言：${clip(entry.text, 200) || "（无言）"}`);
      break;
    case "system":
      push(entry.day, `第${entry.day}天：${entry.text}`);
      break;
  }
}

export function buildReviewPacket(
  state: WerewolfState,
  events: ArenaEvent[],
  maxChars = DEFAULT_REVIEW_RULES.maxChronicleChars,
): ReviewPacket {
  const facts = collectFacts(state, events);
  const factsText = renderFacts(state, facts);
  const chronicle = renderChronicle(state, events, maxChars);
  return {
    name: state.spec.name,
    briefing: state.spec.briefing,
    winner: state.winner,
    endReason: state.endReason ?? "",
    days: facts.days,
    seats: state.seats
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((s) => ({ seat: s.seat, role: s.role, camp: s.camp, alive: s.alive, death: s.death })),
    facts,
    factsText,
    chronicle,
  };
}

/* ── prompt ────────────────────────────────────────────────────────── */

export interface ReviewRater {
  kind: "seat" | "judge";
  seat?: number;
}

export interface ReviewPrompt {
  system: string;
  messages: Array<{ role: "user"; content: string; cacheAt?: number }>;
}

function rubricText(rules: ReviewRules): string {
  return REVIEW_DIMENSIONS.map((key) => {
    const meta = REVIEW_DIMENSION_META[key];
    const weight = Math.round(rules.weights[key] * 100);
    return `- \`${key}\`「${meta.label}」占 ${weight}%：${meta.hint}。锚点：${meta.anchor}`;
  }).join("\n");
}

export function buildReviewPrompt(input: {
  packet: ReviewPacket;
  rater: ReviewRater;
  rules: ReviewRules;
  /** The seat the judge also played, when the referee sat at this table. */
  judgeSeat?: number | null;
}): ReviewPrompt {
  const { packet, rater, rules } = input;
  const isJudge = rater.kind === "judge";
  const seat = rater.seat ?? 0;
  const judgeSeat = isJudge ? (input.judgeSeat ?? null) : null;
  const selfLine = isJudge
    ? judgeSeat === null
      ? "你是本局裁判。你没有阵营，也不坐在桌上。"
      : `你是本局裁判，同时也坐在 ${judgeSeat + 1} 号位。这一票按裁判视角打：全桌 9 个座位都要评，包括你自己那一席。`
    : `你是 ${seat + 1} 号玩家。你已经在牌桌上打完了这一局；现在牌局结束，所有底牌翻开。`;
  const identityRule = isJudge
    ? "你看到的只有 1–9 号座位：没有模型名、厂商名、真名。不要猜，也不需要在评语里提。"
    : "你只知道座位号：不要写模型名、厂商名、真名，也不要猜其他座位是谁。";

  // 十张票读的是同一份大包：system 必须逐字节一致，谁的身份都放到 user 尾巴去。
  const system = [
    `你是「${packet.name}」的赛后评委。`,
    "这是一次赛后复盘，不是牌桌发言，也不是助手任务：给全桌 9 个座位的牌技打分。",
    "",
    "## 规则背景",
    clip(packet.briefing, 1200),
    "",
    "## 评分维度",
    rubricText(rules),
    "",
    "## 评分纪律",
    "- 评的是牌技，不看阵营胜负；胜方不加分，败方也可以拿本局最高分。",
    "- 不要结果论：评价一个决策时，以他当时能看到的公开信息为准。赛后真相只用来核对谁说谎、谁判断对，不用来倒推“他应该早就知道”。",
    "- 不因被骗而扣分；骗得好是能力。狼人悍跳成功，表达和操作就该高。",
    "- 9 个座位的总分必须有区分度：至少出现 3 个不同分值，不要全部挤在 7–8，也不要所有人同分。",
    "- 弃权、AFK、挂机按实际表现打分，不额外补分；在评语里注明即可。",
    "",
    "## 输出协议（严格 JSON，不要代码围栏，不要解释）",
    "只输出一个 JSON 对象，结构如下：",
    `{"scores":[{"seat":1,"read":7,"voice":8,"craft":6,"poise":7,"comment":"一句话"},{"seat":2,"read":5,"voice":6,"craft":5,"poise":6,"comment":"一句话"}],"mvp":4,"bestSpeech":2,"bestDeception":7,"summary":"一句话总结"}`,
    "要求：",
    "- `scores` 恰好 9 行；`seat` 取 1–9，每个座位恰好一次。",
    "- `read` / `voice` / `craft` / `poise` 都是 1–10 的整数。",
    "- `mvp` / `bestSpeech` / `bestDeception` 各取一个 1–9 的座位号，可以来自败方，可以投自己。",
    "- `comment` ≤60 字；`summary` ≤200 字。",
    "- JSON 之后不要再写任何内容。",
  ].join("\n");

  // 事实卡与编年史对十张票完全相同，排在最前；这一票是谁在打，只写在尾巴。
  const packetBlock = [
    "## 赛后事实卡",
    packet.factsText,
    "",
    "## 公开编年史",
    packet.chronicle,
  ].join("\n");

  const mine = [
    "## 这一票是谁在打",
    selfLine,
    identityRule,
    isJudge
      ? `- 你的票按 ${rules.judgeVotes} 票计入；玩家各 1 票。公平、独立，不参考任何其他人的评分。`
      : `- 你的票与其他人等权；裁判另有 ${rules.judgeVotes} 票。公平、独立，不参考任何其他人的评分。`,
    isJudge
      ? "- 每个座位写一句评语（≤60 字），写清他这一局最强或最弱的一手。"
      : "- 评语可选，但至少给 3 个座位写一句（≤60 字）。",
    isJudge
      ? judgeSeat === null
        ? "- 你必须给 1–9 号每个座位打分；你没有自评。"
        : "- 你必须给 1–9 号每个座位打分；你自己那一席也在这张票里，按同一尺度评，不抬分也不压分。"
      : `- 你必须给 1–9 号每个座位打分，包括你自己。自评会单列展示，${
          rules.selfWeight > 0
            ? `按 ${Math.round(rules.selfWeight * 100)}% 的权重计入你的最终均分`
            : "不计入你的最终均分"
        }。`,
    "",
    "## 你的评分表",
    isJudge
      ? "给 1–9 号每个座位打四维分，写一句评语，再投 MVP / 最佳发言 / 最佳伪装。只输出 JSON。"
      : `给 1–9 号每个座位打四维分（包括你自己 ${seat + 1} 号），投 MVP / 最佳发言 / 最佳伪装。只输出 JSON。`,
  ].join("\n");

  const user = `${packetBlock}\n\n${mine}`;
  return { system, messages: [{ role: "user", content: user, cacheAt: packetBlock.length }] };
}

/* ── parsing ───────────────────────────────────────────────────────── */

export type ReviewParseResult =
  | { ok: true; ballot: ReviewBallotBody }
  | { ok: false; error: string };

function pickSeat(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n - 1 : null;
}

export function parseReviewBallot(raw: string): ReviewParseResult {
  const cleaned = repairJson(raw);
  if (!cleaned) return { ok: false, error: "empty_payload" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, error: `json_parse:${err instanceof Error ? err.message.slice(0, 80) : "bad"}` };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "not_object" };
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.scores)) return { ok: false, error: "scores_missing" };
  if (obj.scores.length !== 9) return { ok: false, error: `scores_length:${obj.scores.length}` };

  const seen = new Set<number>();
  const scores: ReviewScoreRow[] = [];
  for (const rawRow of obj.scores) {
    if (!rawRow || typeof rawRow !== "object") return { ok: false, error: "row_not_object" };
    const row = rawRow as Record<string, unknown>;
    const seat = Number(row.seat);
    if (!Number.isInteger(seat) || seat < 1 || seat > 9) {
      return { ok: false, error: `seat_invalid:${String(row.seat)}` };
    }
    if (seen.has(seat - 1)) return { ok: false, error: `seat_duplicate:${seat}` };
    seen.add(seat - 1);
    const parsedRow: ReviewScoreRow = { seat: seat - 1, read: 0, voice: 0, craft: 0, poise: 0 };
    for (const key of REVIEW_DIMENSIONS) {
      const value = Number(row[key]);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        return { ok: false, error: `score_invalid:${seat}.${key}=${String(row[key])}` };
      }
      parsedRow[key] = value;
    }
    if (typeof row.comment === "string" && row.comment.trim()) {
      parsedRow.comment = row.comment.trim().slice(0, 80);
    }
    scores.push(parsedRow);
  }
  if (seen.size !== 9) return { ok: false, error: "seat_missing" };

  return {
    ok: true,
    ballot: {
      scores,
      mvp: pickSeat(obj.mvp),
      bestSpeech: pickSeat(obj.bestSpeech),
      bestDeception: pickSeat(obj.bestDeception),
      summary: typeof obj.summary === "string" ? obj.summary.trim().slice(0, 200) : "",
    },
  };
}

/* ── aggregation ───────────────────────────────────────────────────── */

function rowFor(ballot: ReviewBallot, seat: number): ReviewScoreRow | null {
  return ballot.scores.find((row) => row.seat === seat) ?? null;
}

function weightedDimensions(
  row: Pick<ReviewScoreRow, "read" | "voice" | "craft" | "poise">,
  weights: ReviewWeights,
): number {
  return (
    row.read * weights.read +
    row.voice * weights.voice +
    row.craft * weights.craft +
    row.poise * weights.poise
  );
}

export function weightedTotal(row: ReviewScoreRow, weights: ReviewWeights): number {
  return Math.round(weightedDimensions(row, weights) * 100) / 10;
}

function weightedTotalOf(
  dims: Record<ReviewDimension, number>,
  weights: ReviewWeights,
): number {
  return Math.round(weightedDimensions(dims, weights) * 100) / 10;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dimensionMean(rows: ReviewScoreRow[], key: ReviewDimension): number {
  return mean(rows.map((row) => row[key]));
}

function pickMost(
  ballots: ReviewBallot[],
  key: "mvp" | "bestSpeech" | "bestDeception",
  ranking: ReviewSeatResult[],
): number | null {
  const counts = new Map<number, number>();
  for (const ballot of ballots) {
    const seat = ballot[key];
    if (seat === null) continue;
    counts.set(seat, (counts.get(seat) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestVotes = -1;
  let bestTotal = -1;
  for (const [seat, votes] of counts) {
    const total = ranking.find((row) => row.seat === seat)?.total ?? 0;
    if (
      votes > bestVotes ||
      (votes === bestVotes &&
        (total > bestTotal || (total === bestTotal && (best === null || seat < best))))
    ) {
      best = seat;
      bestVotes = votes;
      bestTotal = total;
    }
  }
  return best;
}

export function aggregateReview(input: {
  state: WerewolfState;
  ballots: ReviewBallot[];
  judge: ReviewBallot | null;
  rules: ReviewRules;
  missing?: Array<number | "judge">;
}): ReviewVerdict {
  const { state, rules } = input;
  const playerBallots = input.ballots.filter((b) => typeof b.rater === "number");
  const judge = input.judge;
  const allBallots = judge ? [...playerBallots, judge] : playerBallots;

  if (playerBallots.length === 0 && !judge) {
    return {
      attempt: 0,
      weights: rules.weights,
      ranking: [],
      mvp: null,
      bestSpeech: null,
      bestDeception: null,
      provisional: true,
      judge: false,
      raters: { players: 0, judge: false, missing: input.missing ?? [] },
      reason: "no_ballots",
    };
  }

  const rows: ReviewSeatResult[] = state.seats
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((seatState) => {
      const target = seatState.seat;
      const peerEntries = playerBallots
        .filter((ballot) => ballot.rater !== target)
        .map((ballot) => ({ rater: ballot.rater as number, row: rowFor(ballot, target) }))
        .filter((entry): entry is { rater: number; row: ReviewScoreRow } => entry.row !== null);

      let kept = peerEntries;
      let dropped: number[] = [];
      if (rules.trim && peerEntries.length >= 6) {
        const sorted = [...peerEntries].sort(
          (a, b) =>
            weightedTotal(a.row, rules.weights) - weightedTotal(b.row, rules.weights) || a.rater - b.rater,
        );
        const low = sorted[0];
        const high = sorted[sorted.length - 1];
        dropped = [low.rater, high.rater];
        const drop = new Set(dropped);
        kept = peerEntries.filter((entry) => !drop.has(entry.rater));
      }

      const peerN = peerEntries.length;
      const judgeRow = judge ? rowFor(judge, target) : null;
      const judgeN = judgeRow ? rules.judgeVotes : 0;
      const peerRows = kept.map((entry) => entry.row);
      const dims = Object.fromEntries(
        REVIEW_DIMENSIONS.map((key) => [key, dimensionMean(peerRows, key)]),
      ) as Record<ReviewDimension, number>;

      // The self ballot is display-only by default; a blueprint can give it a
      // fractional weight (0.5) without ever making it worth a full peer vote.
      const selfRow = playerBallots.find((ballot) => ballot.rater === target) ?? null;
      const selfScoreRow = selfRow ? rowFor(selfRow, target) : null;
      const selfWeight = selfScoreRow ? rules.selfWeight : 0;
      const denominator = peerN + judgeN + selfWeight;

      const finalDims = Object.fromEntries(
        REVIEW_DIMENSIONS.map((key) => {
          if (denominator === 0) return [key, 1];
          const judgeValue = judgeRow ? judgeRow[key] : 0;
          const selfValue = selfScoreRow ? selfScoreRow[key] : 0;
          return [
            key,
            (dims[key] * peerN + judgeValue * judgeN + selfValue * selfWeight) / denominator,
          ];
        }),
      ) as Record<ReviewDimension, number>;

      const judgeTotal = judgeRow ? weightedTotal(judgeRow, rules.weights) : null;

      return {
        seat: target,
        read: Math.round(finalDims.read * 10) / 10,
        voice: Math.round(finalDims.voice * 10) / 10,
        craft: Math.round(finalDims.craft * 10) / 10,
        poise: Math.round(finalDims.poise * 10) / 10,
        total: weightedTotalOf(finalDims, rules.weights),
        judgeTotal,
        selfTotal: selfScoreRow ? weightedTotal(selfScoreRow, rules.weights) : null,
        mvpVotes: allBallots.filter((ballot) => ballot.mvp === target).length,
        bestSpeechVotes: allBallots.filter((ballot) => ballot.bestSpeech === target).length,
        bestDeceptionVotes: allBallots.filter((ballot) => ballot.bestDeception === target).length,
        rank: 0,
        tied: false,
        ballots: peerN + judgeN,
        dropped,
      };
    });

  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (b.mvpVotes !== a.mvpVotes) return b.mvpVotes - a.mvpVotes;
    const judgeA = a.judgeTotal ?? -1;
    const judgeB = b.judgeTotal ?? -1;
    if (judgeB !== judgeA) return judgeB - judgeA;
    if (b.craft !== a.craft) return b.craft - a.craft;
    if (b.read !== a.read) return b.read - a.read;
    return a.seat - b.seat;
  });

  for (let i = 0; i < rows.length; i += 1) {
    rows[i].rank = i + 1;
    const sameAsPrev = i > 0 && rows[i - 1].total === rows[i].total;
    const sameAsNext = i < rows.length - 1 && rows[i + 1].total === rows[i].total;
    rows[i].tied = sameAsPrev || sameAsNext;
  }

  const mvp = pickMost(allBallots, "mvp", rows);
  const bestSpeech = pickMost(allBallots, "bestSpeech", rows);
  const bestDeception = pickMost(allBallots, "bestDeception", rows);

  return {
    attempt: 0,
    weights: rules.weights,
    ranking: rows,
    mvp,
    bestSpeech,
    bestDeception,
    provisional: playerBallots.length < rules.minBallots,
    judge: !!judge,
    raters: {
      players: playerBallots.length,
      judge: !!judge,
      missing: input.missing ?? [],
    },
  };
}

/* ── event replay ──────────────────────────────────────────────────── */

export interface ReviewAttempt {
  attempt: number;
  opened: boolean;
  verdict: ReviewVerdict | null;
  ballots: ReviewBallot[];
  terminal: Array<number | "judge">;
}

const EMPTY_ATTEMPT: ReviewAttempt = {
  attempt: 0,
  opened: false,
  verdict: null,
  ballots: [],
  terminal: [],
};

function raterKey(rater: number | "judge"): string {
  return rater === "judge" ? "judge" : `seat:${rater}`;
}

/** Read the latest review attempt out of the event stream. Pure; used by runtime and tests. */
export function reviewAttempt(events: ArenaEvent[]): ReviewAttempt {
  let attempt = 0;
  for (const event of events) {
    if (event.type !== "review.opened" && event.type !== "review.verdict") continue;
    attempt = Math.max(attempt, num(event.payload.attempt, 0));
  }
  if (attempt === 0) return { ...EMPTY_ATTEMPT, ballots: [], terminal: [] };

  const opened = events.some(
    (event) => event.type === "review.opened" && num(event.payload.attempt, 0) === attempt,
  );
  const ballots = new Map<string, ReviewBallot>();
  const terminal = new Map<string, number | "judge">();
  let verdict: ReviewVerdict | null = null;

  for (const event of events) {
    if (num(event.payload.attempt, 0) !== attempt) continue;
    if (event.type === "review.ballot") {
      const rater = event.payload.rater === "judge" ? "judge" : num(event.payload.rater, Number.NaN);
      if (rater !== "judge" && !Number.isInteger(rater)) continue;
      terminal.set(raterKey(rater), rater);
      if (event.payload.status !== "ok") continue;
      const body = event.payload.ballot;
      if (!body || typeof body !== "object") continue;
      const typed = body as unknown as ReviewBallotBody;
      if (!Array.isArray(typed.scores) || typed.scores.length !== 9) continue;
      ballots.set(raterKey(rater), { ...typed, rater });
    } else if (event.type === "review.verdict") {
      verdict = event.payload as unknown as ReviewVerdict;
    }
  }

  return {
    attempt,
    opened,
    verdict,
    ballots: [...ballots.values()],
    terminal: [...terminal.values()],
  };
}
