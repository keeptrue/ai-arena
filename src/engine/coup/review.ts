/**
 * Coup post-game review: pure half.
 *
 * Four players and one judge grade four dimensions. The facts card is the only
 * thing raters see: no model names, no thinking, no other ballots. Everything the
 * engine knows about the match is reduced to seat numbers and public facts.
 */

import type { CoupRole, CoupState } from "./types";

export const COUP_DIMENSIONS = ["bluff", "read", "tempo", "poise"] as const;
export type CoupDimension = (typeof COUP_DIMENSIONS)[number];

export const COUP_DIMENSION_META: Record<CoupDimension, { label: string; hint: string }> = {
  bluff: {
    label: "诈唬",
    hint: "假身份说得像真的、骗过质疑、在最该骗的时候骗。被抓到一次不致命，被抓到三次说明节奏不对。",
  },
  read: {
    label: "读人",
    hint: "质疑的命中率，以及有没有在该出手时出手。只敢质疑明显假话的人和乱开枪的人得分相同地低。",
  },
  tempo: {
    label: "资源",
    hint: "金币转化为伤害的效率：什么时候囤、什么时候花、政变的时机是否卡在对手反应不过来的时候。",
  },
  poise: {
    label: "气势",
    hint: "桌面上的压迫感：喊话是否让人犹豫，被质疑时是否稳，出局时是否体面。",
  },
};

export interface CoupReviewRules {
  enabled: boolean;
  selfWeight: number;
  judgeVotes: number;
  trim: boolean;
  minBallots: number;
  weights: Record<CoupDimension, number>;
}

export const DEFAULT_COUP_REVIEW_RULES: CoupReviewRules = {
  enabled: true,
  selfWeight: 0,
  judgeVotes: 1,
  trim: false,
  minBallots: 2,
  weights: { bluff: 0.3, read: 0.3, tempo: 0.25, poise: 0.15 },
};

export function resolveCoupReviewRules(spec: CoupState["spec"]): CoupReviewRules {
  const raw = spec.review ?? {};
  const weights = { ...DEFAULT_COUP_REVIEW_RULES.weights };
  if (raw.weights) {
    for (const key of COUP_DIMENSIONS) {
      const value = raw.weights[key];
      if (typeof value === "number" && value >= 0) weights[key] = value;
    }
  }
  const total = COUP_DIMENSIONS.reduce((sum, key) => sum + weights[key], 0);
  if (total <= 0) {
    for (const key of COUP_DIMENSIONS) weights[key] = DEFAULT_COUP_REVIEW_RULES.weights[key];
  } else if (Math.abs(total - 1) > 1e-6) {
    for (const key of COUP_DIMENSIONS) weights[key] = weights[key] / total;
  }
  return {
    enabled: raw.enabled ?? DEFAULT_COUP_REVIEW_RULES.enabled,
    selfWeight: clamp01(raw.selfWeight ?? DEFAULT_COUP_REVIEW_RULES.selfWeight),
    judgeVotes: Math.max(0, Math.min(3, raw.judgeVotes ?? DEFAULT_COUP_REVIEW_RULES.judgeVotes)),
    trim: raw.trim ?? DEFAULT_COUP_REVIEW_RULES.trim,
    minBallots: Math.max(1, Math.min(4, raw.minBallots ?? DEFAULT_COUP_REVIEW_RULES.minBallots)),
    weights,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/* ── facts ─────────────────────────────────────────────────────────── */

export interface CoupFactSeat {
  seat: number;
  coins: number;
  hand: CoupRole[];
  revealed: Array<{ role: CoupRole; turn: number; cause: string }>;
  alive: boolean;
  claims: Array<{ turn: number; action: string; role: CoupRole | null; honest: boolean }>;
  challenges: Array<{ turn: number; target: number; hit: boolean | null }>;
  bluffs: number;
  challengeHits: number;
  challengeMisses: number;
  /** Coins gained per turn, for the tempo read. */
  coinTrail: number[];
}

export interface CoupFacts {
  turns: number;
  winner: number | null;
  endReason: string;
  seats: CoupFactSeat[];
}

/**
 * Rebuild the facts card from the terminal state plus the public log.
 *
 * `honest` is derived from what the seat actually held at the moment of the claim,
 * which the reducer recorded on the log entry — the review never re-simulates.
 */
export function collectCoupFacts(state: CoupState): CoupFacts {
  const seats: CoupFactSeat[] = state.seats.map((seat) => {
    const claims = seat.history.map((h) => ({
      turn: h.turn,
      action: h.action,
      role: h.role,
      honest: h.honest,
    }));
    const challenges: CoupFactSeat["challenges"] = [];
    return {
      seat: seat.seat,
      coins: seat.coins,
      hand: seat.cards.map((c) => c.role),
      revealed: seat.revealed.map((c) => ({ role: c.role, turn: c.turn, cause: c.cause })),
      alive: seat.alive,
      claims,
      challenges,
      bluffs: seat.stats.bluffs,
      challengeHits: seat.stats.hits,
      challengeMisses: Math.max(0, seat.stats.challenges - seat.stats.hits),
      coinTrail: [seat.coins],
    };
  });

  return {
    turns: state.turn,
    winner: state.winner,
    endReason: state.endReason ?? "unknown",
    seats,
  };
}

const ROLE_ZH: Record<CoupRole, string> = {
  duke: "公爵",
  assassin: "刺客",
  captain: "队长",
  ambassador: "大使",
  contessa: "伯爵夫人",
};

const CAUSE_ZH: Record<string, string> = {
  challenge_lost: "质疑失败",
  challenge_failed: "被质疑成功",
  assassinated: "刺杀",
  coup: "政变",
};

export function renderCoupFacts(facts: CoupFacts): string {
  const lines: string[] = [];
  lines.push(`共 ${facts.turns} 回合。`);
  lines.push(
    facts.winner === null
      ? "结局：无人胜出。"
      : `结局：${facts.winner + 1} 号获胜（${facts.endReason}）。`,
  );
  lines.push("");
  for (const seat of facts.seats) {
    lines.push(`### ${seat.seat + 1} 号`);
    lines.push(
      `- 收场：${seat.alive ? "存活" : "出局"}，${seat.coins} 枚金币，${seat.hand.length} 条命。`,
    );
    lines.push(
      `- 最终手牌：${seat.hand.map((r) => ROLE_ZH[r]).join("、") || "（无）"}。`,
    );
    if (seat.revealed.length) {
      lines.push(
        `- 失去的牌：${seat.revealed
          .map((r) => `${ROLE_ZH[r.role]}（第 ${r.turn} 回合，${CAUSE_ZH[r.cause] ?? r.cause}）`)
          .join("；")}。`,
      );
    }
    lines.push(
      `- 诈唬 ${seat.bluffs} 次；质疑 ${seat.challengeHits + seat.challengeMisses} 次，命中 ${seat.challengeHits} 次。`,
    );
  }
  return lines.join("\n");
}

/* ── ballot ────────────────────────────────────────────────────────── */

export interface CoupBallotRow {
  seat: number;
  bluff: number;
  read: number;
  tempo: number;
  poise: number;
  note: string;
}

export interface CoupBallot {
  rows: CoupBallotRow[];
}

export function buildCoupBallotPrompt(input: {
  facts: CoupFacts;
  raterSeat: number | "judge";
  rules: CoupReviewRules;
}): { system: string; messages: Array<{ role: "user"; content: string; cacheAt?: number }> } {
  const system = [
    "你是一场四人政变（Coup）牌局的评委。牌局已经结束，你要给四位玩家各打一个分。",
    "",
    "分数是 0–10 的整数，可以打小数。四个维度：",
    ...COUP_DIMENSIONS.map((key) => `- ${COUP_DIMENSION_META[key].label}（${key}）：${COUP_DIMENSION_META[key].hint}`),
    "",
    "## 规则",
    "- 只看给出的公开事实与最终翻牌，不猜你没看到的东西。",
    "- 不要因为某人赢了就自动给高分：赢家可能是被喂出来的。",
    "- 不要因为某人是自己就给高分：自评会被单独列出，不计入均分。",
    "- 评语写 30–80 字，说清一个具体的判断，不要空话。",
    "",
    "## 输出",
    "严格输出 JSON，不要代码围栏、不要解释：",
    '{"rows":[{"seat":1,"bluff":7,"read":8,"tempo":6,"poise":5,"note":"……"},…]}',
    "必须恰好四行，seat 取 1–4。",
  ].join("\n");

  const factsBlock = renderCoupFacts(input.facts);
  const user = [
    "## 事实卡",
    factsBlock,
    "",
    "## 你的身份",
    input.raterSeat === "judge" ? "你是本局的裁判，不参与对局。" : `你是 ${input.raterSeat + 1} 号玩家。`,
    "",
    "给四位玩家各打一个分。",
  ].join("\n");

  return { system, messages: [{ role: "user", content: user, cacheAt: factsBlock.length }] };
}

export function parseCoupBallot(raw: string): CoupBallot | null {
  const text = stripFence(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return null;

  const out: CoupBallotRow[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const seat = Number(r.seat) - 1;
    if (!Number.isInteger(seat) || seat < 0 || seat > 3 || seen.has(seat)) continue;
    seen.add(seat);
    out.push({
      seat,
      bluff: clampScore(r.bluff),
      read: clampScore(r.read),
      tempo: clampScore(r.tempo),
      poise: clampScore(r.poise),
      note: typeof r.note === "string" ? r.note.trim().slice(0, 120) : "",
    });
  }
  if (out.length !== 4) return null;
  return { rows: out.sort((a, b) => a.seat - b.seat) };
}

function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

function stripFence(text: string): string {
  return text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
}

/* ── aggregation ───────────────────────────────────────────────────── */

export interface CoupReviewBallot {
  rater: number | "judge";
  rows: CoupBallotRow[];
}

export interface CoupSeatScore {
  seat: number;
  dimensions: Record<CoupDimension, number>;
  total: number;
  ballots: number;
  selfTotal: number | null;
  notes: string[];
}

export interface CoupVerdict {
  seats: CoupSeatScore[];
  champion: number | null;
  provisional: boolean;
  bestBluff: { seat: number; note: string } | null;
  bestRead: { seat: number; note: string } | null;
}

export function aggregateCoupReview(input: {
  ballots: CoupReviewBallot[];
  rules: CoupReviewRules;
}): CoupVerdict {
  const { ballots, rules } = input;
  const seats: CoupSeatScore[] = [];

  for (let seat = 0; seat < 4; seat++) {
    const peerRows: Array<{ row: CoupBallotRow; weight: number }> = [];
    let selfRow: CoupBallotRow | null = null;

    for (const ballot of ballots) {
      const row = ballot.rows.find((r) => r.seat === seat);
      if (!row) continue;
      if (ballot.rater === seat) {
        selfRow = row;
        if (rules.selfWeight > 0) peerRows.push({ row, weight: rules.selfWeight });
        continue;
      }
      peerRows.push({ row, weight: ballot.rater === "judge" ? Math.max(1, rules.judgeVotes) : 1 });
    }

    const dimensions = {} as Record<CoupDimension, number>;
    for (const key of COUP_DIMENSIONS) {
      dimensions[key] = weightedMean(peerRows.map((p) => ({ value: p.row[key], weight: p.weight })));
    }
    const total = COUP_DIMENSIONS.reduce((sum, key) => sum + dimensions[key] * rules.weights[key], 0);

    seats.push({
      seat,
      dimensions,
      total: round1(total),
      ballots: peerRows.length,
      selfTotal: selfRow ? round1(weightedTotal(selfRow, rules.weights)) : null,
      notes: peerRows.map((p) => p.row.note).filter(Boolean),
    });
  }

  const ranked = [...seats].sort((a, b) => b.total - a.total);
  const top = ranked[0];
  const second = ranked[1];
  const champion =
    top && (!second || top.total > second.total) && top.total > 0 ? top.seat : null;

  return {
    seats,
    champion,
    provisional: seats.some((s) => s.ballots < rules.minBallots),
    bestBluff: pickBest(seats, "bluff"),
    bestRead: pickBest(seats, "read"),
  };
}

function pickBest(seats: CoupSeatScore[], key: CoupDimension): { seat: number; note: string } | null {
  const best = [...seats].sort((a, b) => b.dimensions[key] - a.dimensions[key])[0];
  if (!best || best.dimensions[key] <= 0) return null;
  return { seat: best.seat, note: best.notes[0] ?? "" };
}

function weightedTotal(row: CoupBallotRow, weights: Record<CoupDimension, number>): number {
  return COUP_DIMENSIONS.reduce((sum, key) => sum + row[key] * weights[key], 0);
}

function weightedMean(rows: Array<{ value: number; weight: number }>): number {
  if (rows.length === 0) return 0;
  const total = rows.reduce((sum, r) => sum + r.weight, 0);
  if (total <= 0) return 0;
  return round1(rows.reduce((sum, r) => sum + r.value * r.weight, 0) / total);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
