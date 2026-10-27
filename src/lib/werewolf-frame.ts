/**
 * Pure view model for the nine-seat table.
 *
 * Everything here is a function of the event stream: no React, no I/O. The table
 * component owns the reducer, the reel owns the pixels, and this module owns the
 * answers to "what does this frame look like" and "what did this seat do".
 */

import type { ModelSnapshot } from "@/engine/types";
import type {
  DeathCause,
  WerewolfCamp,
  WerewolfPhase,
  WerewolfRoleId,
} from "@/engine/werewolf/types";
// Type-only: the engine owns the review shapes, the frame owns the view of them.
import type {
  ReviewBallotBody,
  ReviewDimension,
  ReviewScoreRow,
  ReviewSeatResult,
  ReviewVerdict,
  ReviewWeights,
} from "@/engine/werewolf/review";
import { salvageSpeech } from "@/engine/werewolf/speech";

/* ── view types ────────────────────────────────────────────────────── */

export interface TableSeatView {
  seat: number;
  participantId: string;
  display: string;
  provider: string;
  modelId: string;
  role: WerewolfRoleId | null;
  camp: WerewolfCamp | null;
  alive: boolean;
  death: { day?: number; cause?: DeathCause } | null;
  afk: boolean;
  status: "idle" | "thinking" | "ready" | "forfeit" | "dead";
  thinking: string;
  thinkingDone: boolean;
  /** Native reasoning channel, kept apart from the audience note. */
  reasoning: string;
  action: Record<string, unknown> | null;
  vote: number | "abstain" | null;
  voteCount: number;
  lastWords: string | null;
  lastSpeech: string | null;
}

export interface TableLogItem {
  seq: number;
  day: number;
  /** Phase the fact belongs to; lets a night frame stay free of day speeches. */
  phase?: WerewolfPhase;
  text: string;
  tone: "blood" | "jade" | "amber" | "ghost" | "muted";
  seat?: number;
  kind: string;
  /** Short column label for synthesized rows (刀 / 验 / 结算 …). */
  tag?: string;
}

export interface TableVoteRecord {
  day: number;
  counts: Record<number, number>;
  votes: Record<number, number | "abstain">;
  exiled: number | null;
  tie: number[];
  pk: boolean;
}

export interface TableThought {
  day: number;
  phase: WerewolfPhase;
  seat: number;
  text: string;
  native: string;
}

/** One seat's action, kept for the whole match so replay shows the same facts. */
export interface TableAction {
  seq: number;
  day: number;
  phase: WerewolfPhase;
  seat: number | null;
  kind: string;
  tag: string;
  label: string;
  target: number | "abstain" | null;
  detail: string;
  tone: TableLogItem["tone"];
}

/** One seat's move inside a decision round, paired with the note it left. */
export interface TableDecision {
  seat: number;
  phase: WerewolfPhase;
  /** `投 7号` / `刀 3号` / `验 2号` / `弃权` … */
  label: string;
  target: number | "abstain" | null;
  /** The audience note (`<<<THINK>>>`), raw. */
  note: string;
  /** The provider's native reasoning channel, kept apart. */
  native: string;
  status: "thinking" | "ready" | "forfeit" | "waiting";
}

/** A decision round is one phase: the vote, the PK re-vote, the wolves' kill… */
export interface DecisionRound {
  phase: WerewolfPhase;
  label: string;
  rows: TableDecision[];
}

/* ── post-game review ──────────────────────────────────────────────── */

/**
 * The review runs on its own event family (`review.opened` / `review.ballot` /
 * `review.verdict`) and is owned by `engine/werewolf/review.ts`. Only types cross
 * that boundary: the wire shape has one definition, and no engine code lands in
 * the client bundle.
 */
export type TableReviewScoreRow = ReviewScoreRow;
export type TableReviewBallotBody = ReviewBallotBody;
export type TableReviewSeatResult = ReviewSeatResult;
export type TableReviewVerdict = ReviewVerdict;

/** The rubric exactly as `review.opened` reports it (`ReviewRules` minus the chronicle budget). */
export interface ReviewRubric {
  weights: ReviewWeights;
  /** 0 = a seat's own ballot is display-only. */
  selfWeight: number;
  /** The judge ballot is worth this many player ballots. */
  judgeVotes: number;
  /** Drop one highest and one lowest peer ballot per seat before averaging. */
  trim: boolean;
  /** Below this many valid player ballots the verdict is provisional. */
  minBallots: number;
}

/** One rater's answer: `ok` carries a ballot, `forfeit` carries only the reason. */
export interface TableReviewBallot {
  rater: number | "judge";
  status: string;
  ballot: TableReviewBallotBody | null;
  /** Why the rater never scored anyone; empty when `status === "ok"`. */
  error: string;
}

/**
 * One rater's live stream. A review call is a call like any other: the audience
 * can watch it think, and the panel typewrites while the ballot is being written.
 * Only the tail is kept — a 30k-character deliberation must not sit in state.
 */
export interface TableReviewStream {
  rater: number | "judge";
  /** Epoch ms the ballot was announced; null when only chunks survived a reload. */
  startedAt: number | null;
  /** Epoch ms of the newest chunk. */
  updatedAt: number;
  /** Total characters written in each channel (not the tail length). */
  reasonChars: number;
  noteChars: number;
  /** Newest `REVIEW_STREAM_TAIL` characters of each channel. */
  reason: string;
  note: string;
}

export interface TableReview {
  /** Bumped by `review.opened`: a re-score is a whole new attempt. */
  attempt: number;
  opened: boolean;
  /** Epoch ms `review.opened` landed; drives the "已等 01:23" clock. */
  openedAt: number | null;
  /** Events say this attempt is open and has no verdict yet. */
  running: boolean;
  /** How many ballots the attempt expects (9, or 10 with a judge); 0 = unknown. */
  expected: number;
  /** Who is expected to vote, in seat order; empty when the event omitted it. */
  raters: Array<number | "judge">;
  rubric: ReviewRubric | null;
  ballots: TableReviewBallot[];
  /** Live streams of the current attempt, keyed by `seat:N` / `judge`. */
  streams: Record<string, TableReviewStream>;
  verdict: TableReviewVerdict | null;
}

export interface ReviewProgress {
  attempt: number;
  /** Total ballots this attempt expects. */
  expected: number;
  /** Ballots actually in hand. */
  done: number;
  /** Raters that ended without a ballot. */
  failed: number;
  /** Raters still to be heard from. */
  pending: Array<number | "judge">;
  ratio: number;
}

/** Where one rater stands right now. `thinking` is the only state that has a tail. */
export type ReviewRaterState = "done" | "forfeit" | "thinking" | "queued";

/** How many characters of each channel the panel keeps: the newest ones. */
export const REVIEW_STREAM_TAIL = 1_600;

/** House weights, mirrored from `review.ts:DEFAULT_REVIEW_RULES` for offline rendering. */
export const REVIEW_DEFAULT_WEIGHTS: ReviewWeights = {
  read: 0.35,
  voice: 0.3,
  craft: 0.25,
  poise: 0.1,
};

/**
 * The four dimensions as the panel explains them. Copy mirrors
 * `REVIEW_DIMENSION_META` in `engine/werewolf/review.ts`; `share` is the house
 * default the rubric starts from, so a blueprint override still reads correctly.
 */
export const REVIEW_DIMENSION_COPY: ReadonlyArray<{
  key: ReviewDimension;
  label: string;
  hint: string;
  anchor: string;
  share: number;
}> = [
  {
    key: "read",
    label: "判断",
    hint: "信息利用、身份判断、刀口与票型解读",
    anchor:
      "9–10 关键轮次判断正确，并能用当时的公开信息说清依据；5–6 中规中矩，跟随主流；1–2 多次跟错票、站错边，或全程反指。",
    share: 0.35,
  },
  {
    key: "voice",
    label: "表达",
    hint: "发言结构、说服力、悍跳/对跳/抗推，是否带动票型",
    anchor:
      "9–10 发言能定调，票型因他改变，谎言结构完整、经得起追问；5–6 表达清楚但不改变局势；1–2 发言含糊、矛盾多，或被轻易问穿。",
    share: 0.3,
  },
  {
    key: "craft",
    label: "操作",
    hint: "验人、用药、开枪、刀法、投票落点、狼队协同",
    anchor:
      "9–10 每一手都打在关键点、时机正确；5–6 按部就班，无明显失误也无亮点；1–2 关键技能空放、误伤、刀偏或毒好人。",
    share: 0.25,
  },
  {
    key: "poise",
    label: "抗压",
    hint: "被集火、被查杀、被悍跳时的稳定性；不挂机、不摆烂",
    anchor:
      "9–10 压力下仍能稳定输出，能把局面拉回来；5–6 正常波动；1–2 明显情绪化、复读、弃权或破坏对局。",
    share: 0.1,
  },
];

export function emptyReview(): TableReview {
  return {
    attempt: 0,
    opened: false,
    openedAt: null,
    running: false,
    expected: 0,
    raters: [],
    rubric: null,
    ballots: [],
    streams: {},
    verdict: null,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  const n = finiteNumber(value, fallback);
  return n >= 0 ? n : fallback;
}

/** Normalise a serialized `ReviewWeights` blob, one dimension at a time. */
export function reviewWeightSet(
  raw: unknown,
  fallback: ReviewWeights = REVIEW_DEFAULT_WEIGHTS,
): ReviewWeights {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const w = raw as Record<string, unknown>;
  return {
    read: nonNegative(w.read, fallback.read),
    voice: nonNegative(w.voice, fallback.voice),
    craft: nonNegative(w.craft, fallback.craft),
    poise: nonNegative(w.poise, fallback.poise),
  };
}

/** Normalise the `review.opened` rubric payload; a missing or broken field falls back. */
export function reviewRubric(raw: unknown): ReviewRubric | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  return {
    weights: reviewWeightSet(src.weights),
    selfWeight: nonNegative(src.selfWeight, 0),
    judgeVotes: Math.round(nonNegative(src.judgeVotes, 2)),
    trim: src.trim !== false,
    minBallots: Math.max(1, Math.round(nonNegative(src.minBallots, 4))),
  };
}

/** The weights in force for this attempt: verdict → rubric → house defaults. */
export function reviewWeights(review: TableReview): ReviewWeights {
  return review.verdict?.weights ?? review.rubric?.weights ?? REVIEW_DEFAULT_WEIGHTS;
}

function raterKey(rater: number | "judge"): string {
  return rater === "judge" ? "judge" : `seat:${rater}`;
}

function expectedRaters(review: TableReview, judge: boolean): Array<number | "judge"> {
  if (review.raters.length > 0) return review.raters;
  const list: Array<number | "judge"> = Array.from({ length: 9 }, (_, seat) => seat);
  if (judge) list.push("judge");
  return list;
}

/**
 * Ballot arithmetic for the progress chip. `judge` says whether a judge ballot is
 * part of this table at all — the event's `expected` count wins when it is there.
 */
export function reviewProgress(review: TableReview, opts: { judge?: boolean } = {}): ReviewProgress {
  const judge = opts.judge ?? review.verdict?.raters.judge ?? review.raters.includes("judge");
  const list = expectedRaters(review, judge);
  const ok = new Set(
    review.ballots.filter((b) => b.status === "ok").map((b) => raterKey(b.rater)),
  );
  const ended = new Set(
    review.ballots.filter((b) => b.status !== "ok").map((b) => raterKey(b.rater)),
  );
  const done = ok.size;
  const failed = [...ended].filter((key) => !ok.has(key)).length;
  const pending = list.filter((rater) => !ok.has(raterKey(rater)) && !ended.has(raterKey(rater)));
  const expected = Math.max(list.length, review.expected, done + failed);
  return {
    attempt: review.attempt,
    expected,
    done,
    failed,
    pending,
    ratio: expected > 0 ? Math.min(1, done / expected) : 0,
  };
}

/* ── review streams ────────────────────────────────────────────────── */

export function reviewStreamKey(rater: number | "judge"): string {
  return rater === "judge" ? "judge" : `seat:${rater}`;
}

/**
 * Stream events name their attempt, exactly like ballots: a re-score starts from
 * an empty slate, and a chunk from the previous round must never resurrect it.
 */
function attemptBase(review: TableReview, attempt: number): TableReview {
  if (attempt > review.attempt) return { ...emptyReview(), attempt, opened: true, running: true };
  return review;
}

/** The rater has been picked and its call is about to start: it is no longer queued. */
export function applyReviewStarted(
  review: TableReview,
  input: { attempt: number; rater: number | "judge"; ts: number },
): TableReview {
  if (!Number.isInteger(input.attempt) || input.attempt <= 0) return review;
  if (input.attempt < review.attempt) return review;
  const base = attemptBase(review, input.attempt);
  const key = reviewStreamKey(input.rater);
  const prev = base.streams[key];
  const stream: TableReviewStream = {
    rater: input.rater,
    startedAt: input.ts,
    updatedAt: input.ts,
    reasonChars: prev?.reasonChars ?? 0,
    noteChars: prev?.noteChars ?? 0,
    reason: prev?.reason ?? "",
    note: prev?.note ?? "",
  };
  return { ...base, streams: { ...base.streams, [key]: stream } };
}

/**
 * Append one chunk. Characters are counted in full; only the tail is stored, so a
 * long deliberation costs the same memory as a short one.
 */
export function applyReviewDelta(
  review: TableReview,
  input: {
    attempt: number;
    rater: number | "judge";
    channel: string;
    delta: string;
    ts: number;
  },
): TableReview {
  if (!input.delta) return review;
  if (!Number.isInteger(input.attempt) || input.attempt <= 0) return review;
  if (input.attempt < review.attempt) return review;
  const base = attemptBase(review, input.attempt);
  const key = reviewStreamKey(input.rater);
  const prev: TableReviewStream = base.streams[key] ?? {
    rater: input.rater,
    startedAt: null,
    updatedAt: input.ts,
    reasonChars: 0,
    noteChars: 0,
    reason: "",
    note: "",
  };
  // Old events have no channel; they were the visible answer being written.
  const channel = input.channel === "reason" ? "reason" : "note";
  const grown = (prev[channel] + input.delta).slice(-REVIEW_STREAM_TAIL);
  const stream: TableReviewStream =
    channel === "reason"
      ? {
          ...prev,
          startedAt: prev.startedAt ?? input.ts,
          updatedAt: input.ts,
          reasonChars: prev.reasonChars + input.delta.length,
          reason: grown,
        }
      : {
          ...prev,
          startedAt: prev.startedAt ?? input.ts,
          updatedAt: input.ts,
          noteChars: prev.noteChars + input.delta.length,
          note: grown,
        };
  return { ...base, streams: { ...base.streams, [key]: stream } };
}

export function reviewStream(
  review: TableReview,
  rater: number | "judge",
): TableReviewStream | null {
  return review.streams[reviewStreamKey(rater)] ?? null;
}

/** Streams that have anything to show, in seat order (the judge ballot last). */
export function reviewActiveStreams(review: TableReview): TableReviewStream[] {
  return Object.values(review.streams)
    .filter((s) => s.reasonChars + s.noteChars > 0)
    .sort((a, b) => {
      if (a.rater === b.rater) return 0;
      if (a.rater === "judge") return 1;
      if (b.rater === "judge") return -1;
      return a.rater - b.rater;
    });
}

/** A ballot wins over a stream: a rater that answered is done, whatever it wrote. */
export function reviewRaterState(review: TableReview, rater: number | "judge"): ReviewRaterState {
  const ballot = review.ballots.find((b) => b.rater === rater);
  if (ballot) return ballot.status === "ok" ? "done" : "forfeit";
  const stream = reviewStream(review, rater);
  if (!stream) return "queued";
  return stream.startedAt !== null || stream.reasonChars + stream.noteChars > 0
    ? "thinking"
    : "queued";
}

/** The headline the panel prints next to the ballot counter. */
export function reviewLiveCounts(
  review: TableReview,
  opts: { judge?: boolean } = {},
): { thinking: number; queued: number; done: number; failed: number; chars: number } {
  const progress = reviewProgress(review, opts);
  let thinking = 0;
  let queued = 0;
  for (const rater of progress.pending) {
    const state = reviewRaterState(review, rater);
    if (state === "thinking") thinking += 1;
    else if (state === "queued") queued += 1;
  }
  let chars = 0;
  for (const stream of Object.values(review.streams)) chars += stream.reasonChars + stream.noteChars;
  return { thinking, queued, done: progress.done, failed: progress.failed, chars };
}

/** A seat row by seat index; the review only ever has the 9 seats the table shows. */
export function reviewSeat(
  view: { seats: TableSeatView[] },
  seat: number,
): TableSeatView | null {
  return view.seats.find((s) => s.seat === seat) ?? null;
}

/**
 * The model that sat in a seat, as the review panel prints it. `display` is the
 * name the table showed all game; the raw id is the fallback. The provider is
 * prepended only when another seat carries the same name — one model reached
 * through two providers — so the nine cards stay readable. A seat with no roster
 * row names nothing rather than echoing its own number.
 */
export function seatModel(seats: TableSeatView[], seat: number): string {
  const view = reviewSeat({ seats }, seat);
  if (!view || !view.modelId) return "";
  const name = view.display?.trim() || view.modelId;
  const shared = seats.some((other) => {
    if (other.seat === seat || !other.modelId) return false;
    return (other.display?.trim() || other.modelId) === name;
  });
  const provider = view.provider?.trim();
  return shared && provider ? `${provider} · ${name}` : name;
}

/** Provider + raw model id, so two providers of one model stay apart on hover. */
export function seatModelTitle(seats: TableSeatView[], seat: number): string | undefined {
  const view = reviewSeat({ seats }, seat);
  if (!view || !view.modelId) return undefined;
  const title = [view.provider, view.modelId]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" · ");
  return title || undefined;
}

/** One rater's row for one seat, or null when that rater left the seat unscored. */
export function ballotRow(
  ballot: TableReviewBallotBody | null | undefined,
  seat: number,
): ReviewScoreRow | null {
  if (!ballot || !Array.isArray(ballot.scores)) return null;
  return ballot.scores.find((row) => row && row.seat === seat) ?? null;
}

/**
 * One cell of the judge matrix: one rater's weighted score for one seat, kept on
 * the ballot scale (1–10, one decimal). The leaderboard aggregates ten of these
 * into the 0–100 `total`, so the panel labels the two scales apart.
 */
export function ballotTotal(
  row: ReviewScoreRow | null | undefined,
  weights: ReviewWeights | null | undefined,
): number | null {
  if (!row) return null;
  const w = weights ?? REVIEW_DEFAULT_WEIGHTS;
  const total =
    row.read * w.read + row.voice * w.voice + row.craft * w.craft + row.poise * w.poise;
  return Number.isFinite(total) ? Math.round(total * 10) / 10 : null;
}

/** The seat that played the table best: rank 1 of the verdict, or null before a verdict. */
export function reviewChampion(
  verdict: TableReviewVerdict | null,
): TableReviewSeatResult | null {
  if (!verdict || verdict.ranking.length === 0) return null;
  return verdict.ranking[0] ?? null;
}

export interface TableState {
  meta: { name: string; tagline: string; maxDays: number; briefing: string } | null;
  seats: TableSeatView[];
  day: number;
  phase: WerewolfPhase;
  publicLog: TableLogItem[];
  godLog: TableLogItem[];
  votes: Record<number, number | "abstain">;
  counts: Record<number, number>;
  voteHistory: TableVoteRecord[];
  thinkingHistory: TableThought[];
  actions: TableAction[];
  pk: number[];
  winner: { camp: WerewolfCamp | null; name: string | null; reason: string } | null;
  finished: boolean;
  paused: boolean;
  spoken: number;
  speaking: number | null;
  notFound: boolean;
  /** `matches.status` as the API reported it: running / interrupted / finished … */
  status: string;
  /** Is a live seat loop driving this match? A dead process cannot be thinking. */
  live: boolean;
  /** Post-game review, folded from the `review.*` events. */
  review: TableReview;
  /** The judge's display name as the API reported it; only the review names a judge. */
  judgeName: string | null;
}

export interface Frame {
  id: string;
  kind: "night" | "day" | "end";
  day: number;
  no: string;
  label: string;
  title: string;
  sub: string;
  caption: string;
  items: TableLogItem[];
  godItems: TableLogItem[];
  deaths: number[];
  speeches: number[];
  vote: TableVoteRecord | null;
}

/* ── labels ────────────────────────────────────────────────────────── */

export const ROLE_LABEL: Record<WerewolfRoleId, string> = {
  wolf: "狼人",
  seer: "预言家",
  witch: "女巫",
  hunter: "猎人",
  villager: "村民",
};

export const DEATH_LABEL: Record<DeathCause, string> = {
  wolf: "狼刀",
  poison: "毒杀",
  vote: "放逐",
  hunter: "枪杀",
  self_destruct: "自爆",
};

export const PHASE_CHIP: Record<WerewolfPhase, string> = {
  dealing: "发牌中",
  night_wolves: "狼人行动",
  night_seer: "预言家验人",
  night_witch: "女巫用药",
  dawn: "天亮了",
  hunter_shot: "猎人开枪",
  day_last_words: "遗言",
  day_speech: "发言中",
  day_vote: "投票中",
  day_pk_speech: "PK 发言",
  day_pk_vote: "PK 重投",
  done: "已终局",
};

/** The moment a note was written, phrased for the reading column. */
export const THOUGHT_LABEL: Record<WerewolfPhase, string> = {
  dealing: "发牌",
  night_wolves: "刀口前",
  night_seer: "验人前",
  night_witch: "用药前",
  dawn: "天亮",
  hunter_shot: "开枪前",
  day_last_words: "遗言前",
  day_speech: "发言前",
  day_vote: "投票时",
  day_pk_speech: "PK 发言前",
  day_pk_vote: "PK 重投时",
  done: "终局",
};

const NIGHT_DECISION_PHASES: WerewolfPhase[] = ["night_wolves", "night_seer", "night_witch"];
const DAY_DECISION_PHASES: WerewolfPhase[] = ["day_vote", "day_pk_vote", "hunter_shot"];

const DECISION_ROUND_LABEL: Partial<Record<WerewolfPhase, string>> = {
  night_wolves: "狼人刀口",
  night_seer: "预言家查验",
  night_witch: "女巫用药",
  day_vote: "放逐投票",
  day_pk_vote: "PK 重投",
  hunter_shot: "猎人开枪",
};

/** Phase order inside a frame, so a seat's notes read chronologically. */
const THOUGHT_ORDER: Record<WerewolfPhase, number> = {
  dealing: -1,
  night_wolves: 0,
  night_seer: 1,
  night_witch: 2,
  dawn: 3,
  day_speech: 4,
  day_vote: 5,
  day_pk_speech: 6,
  day_pk_vote: 7,
  hunter_shot: 8,
  day_last_words: 9,
  done: 10,
};

const REASON_LABEL: Record<string, string> = {
  wolves_out: "放逐全部狼人",
  gods_wiped: "屠神",
  villagers_wiped: "屠民",
  day_limit: "超过天数上限",
  phase_guard: "状态机保护",
  budget_exceeded: "预算耗尽",
  aborted: "中止",
};

const DAY_PHASES = new Set<WerewolfPhase>([
  "dawn",
  "day_speech",
  "day_vote",
  "day_pk_speech",
  "day_pk_vote",
  "day_last_words",
  "hunter_shot",
  "done",
]);

const NIGHT_ACTION_PHASES = new Set<WerewolfPhase>(["night_wolves", "night_seer", "night_witch"]);

const NIGHT_FRAME_PHASES = new Set<WerewolfPhase>([
  "night_wolves",
  "night_seer",
  "night_witch",
  "dawn",
]);

const PHASE_LABEL: Partial<Record<WerewolfPhase, string>> = {
  dealing: "发牌",
  night_wolves: "狼人行动",
  night_seer: "预言家验人",
  night_witch: "女巫用药",
  dawn: "天亮了",
  hunter_shot: "猎人开枪",
  day_last_words: "遗言",
  day_speech: "白天发言",
  day_vote: "放逐投票",
  day_pk_speech: "PK 发言",
  day_pk_vote: "PK 重投",
  done: "终局",
};

const NIGHT_KINDS = new Set([
  "wolf.chat",
  "seer.check",
  "night.resolved",
  "died",
  "afk",
  "anomaly",
  "dm",
]);

function isDayPhase(phase: WerewolfPhase): boolean {
  return DAY_PHASES.has(phase);
}

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

/* ── constructors ──────────────────────────────────────────────────── */

export function blankSeat(
  seat: number,
  participantId = `seat-${seat}`,
  display = `${seat + 1}号`,
): TableSeatView {
  return {
    seat,
    participantId,
    display,
    provider: "",
    modelId: "",
    role: null,
    camp: null,
    alive: true,
    death: null,
    afk: false,
    status: "idle",
    thinking: "",
    thinkingDone: false,
    reasoning: "",
    action: null,
    vote: null,
    voteCount: 0,
    lastWords: null,
    lastSpeech: null,
  };
}

export function emptyTable(): TableState {
  return {
    meta: null,
    seats: [],
    day: 0,
    phase: "dealing",
    publicLog: [],
    godLog: [],
    votes: {},
    counts: {},
    voteHistory: [],
    thinkingHistory: [],
    actions: [],
    pk: [],
    winner: null,
    finished: false,
    paused: false,
    spoken: 0,
    speaking: null,
    notFound: false,
    status: "",
    live: true,
    review: emptyReview(),
    judgeName: null,
  };
}

export function tableFromRoster(
  participants: Array<{ id: string; seat: number; model: ModelSnapshot }>,
): TableState {
  const seats = Array.from({ length: 9 }, (_, seat) => {
    const p = participants.find((x) => x.seat === seat);
    if (!p) return blankSeat(seat);
    return {
      ...blankSeat(seat, p.id, p.model.display),
      provider: p.model.providerName,
      modelId: p.model.modelId,
    };
  });
  return { ...emptyTable(), seats };
}

/* ── text hygiene ──────────────────────────────────────────────────── */

/**
 * The audience note: protocol markers and a bare Markdown quote line removed.
 * Filtering paragraphs by language used to hide half of a bilingual model's
 * reasoning; that material now lives in its own channel instead of being
 * silently dropped.
 */
export function cleanThinking(raw: string): string {
  let text = String(raw ?? "");
  const submit = text.indexOf("<<<SUBMIT>>>");
  if (submit >= 0) text = text.slice(0, submit);
  text = text.replace(/<<<[^>]*>>>/g, "").trim();
  // Some models wrap the whole note in a Markdown quote; a bare `>` line is
  // protocol noise, not content. A quote with text (`> 引用`) is left alone.
  text = text.replace(/^(?:[ \t]*>[ \t]*(?:\r?\n|$))+/, "").trim();
  return text;
}

/** Native reasoning keeps its own formatting; only the protocol noise is stripped. */
export function cleanNative(raw: string): string {
  return String(raw ?? "")
    .replace(/<<<[^>]*>>>/g, "")
    .trim();
}

/**
 * A speech must be a speech: `salvageSpeech` recovers the line from a broken
 * payload, so a failed parse can never dump the whole turn into the transcript.
 */
export function cleanSpeech(raw: string): string {
  return salvageSpeech(String(raw ?? ""))
    .replace(/<<<[^>]*>>>/g, "")
    .trim();
}

export function logText(item: TableLogItem): string {
  let text = cleanSpeech(item.text);
  if (item.seat != null) {
    const n = item.seat + 1;
    text = text
      .replace(new RegExp(`^${n}号(?:（PK）)?(?:发言|遗言)[。：:]\\s*`), "")
      .trim();
  }
  return text || "（空）";
}

export function kindLabel(item: TableLogItem): string {
  if (item.tag) return item.tag;
  switch (item.kind) {
    case "speech":
      return "发言";
    case "vote":
      return "投票";
    case "last_words":
      return "遗言";
    case "dawn":
      return "天亮";
    case "exile":
      return "放逐";
    case "no_exile":
      return "无出局";
    case "hunter":
      return "开枪";
    case "pk":
      return "PK";
    case "finish":
      return "终局";
    case "roles":
      return "翻牌";
    case "self_destruct":
      return "自爆";
    default:
      return item.kind;
  }
}

/* ── action labels ─────────────────────────────────────────────────── */

/** A short, human-readable label for the decision carried by a submission. */
export function decisionLabel(content: Record<string, unknown>): string {
  const kind = String(content.kind ?? "");
  const target = typeof content.target === "number" ? content.target : null;
  switch (kind) {
    case "wolf":
      return target === null ? "空刀" : `刀 ${target + 1}号`;
    case "seer":
      return target === null ? "查验" : `验 ${target + 1}号`;
    case "witch": {
      const action = String(content.action ?? "");
      if (action === "save") return target === null ? "解药" : `救 ${target + 1}号`;
      if (action === "poison") return target === null ? "毒药" : `毒 ${target + 1}号`;
      return "不用药";
    }
    case "vote":
      return content.target === "abstain" ? "弃票" : target === null ? "投票" : `投 ${target + 1}号`;
    case "hunter":
      return target === null ? "不开枪" : `开枪 ${target + 1}号`;
    case "speech":
      return "发言";
    case "last_words":
      return "遗言";
    default:
      return kind || "提交";
  }
}

/** The ballot line on a seat card: `票 → 7号` / `票 → 弃` / `未投票`. */
export function seatBallot(vote: number | "abstain" | null | undefined): string {
  if (vote == null) return "未投票";
  return vote === "abstain" ? "票 → 弃" : `票 → ${vote + 1}号`;
}

/** The seat card's middle line: a ballot wins over the death cause. */
export function seatCardMid(input: {
  dead: boolean;
  death?: DeathCause | null;
  showRole: boolean;
  vote: number | "abstain" | null;
}): string {
  if (input.vote != null) return seatBallot(input.vote);
  if (input.dead) {
    return input.showRole && input.death ? `出局 · ${DEATH_LABEL[input.death]}` : "出局";
  }
  return "未投票";
}

const ACTION_META: Record<string, { tag: string; tone: TableLogItem["tone"] }> = {
  wolf: { tag: "刀", tone: "blood" },
  seer: { tag: "验", tone: "amber" },
  witch: { tag: "药", tone: "amber" },
  hunter: { tag: "枪", tone: "blood" },
  vote: { tag: "票", tone: "ghost" },
};

/** Turn a submitted action into a ledger row. Speeches are not actions. */
export function actionFromContent(input: {
  seq: number;
  day: number;
  phase: WerewolfPhase;
  seat: number;
  content: Record<string, unknown>;
}): TableAction | null {
  const kind = String(input.content.kind ?? "");
  if (!kind || kind === "speech" || kind === "last_words") return null;
  const meta = ACTION_META[kind] ?? { tag: kind, tone: "muted" as const };
  const talk = typeof input.content.talk === "string" ? input.content.talk.trim() : "";
  return {
    seq: input.seq,
    day: input.day,
    phase: input.phase,
    seat: input.seat,
    kind,
    tag: meta.tag,
    label: decisionLabel(input.content),
    target:
      input.content.target === "abstain"
        ? "abstain"
        : typeof input.content.target === "number"
          ? input.content.target
          : null,
    detail: kind === "wolf" ? talk : "",
    tone: meta.tone,
  };
}

/* ── frames ────────────────────────────────────────────────────────── */

function actionItem(action: TableAction): TableLogItem {
  const text =
    action.kind === "seer" && action.detail
      ? `${action.label} → ${action.detail}`
      : action.detail
        ? `${action.label} · ${action.detail}`
        : action.label;
  return {
    seq: action.seq,
    day: action.day,
    phase: action.phase,
    text,
    tone: action.tone,
    seat: action.seat ?? undefined,
    kind: "action",
    tag: action.tag,
  };
}

export function buildFrames(view: TableState, godView: boolean): Frame[] {
  const frames: Frame[] = [];
  const maxDay = Math.max(1, view.day);
  const dayPhase = isDayPhase(view.phase);
  const finished = view.finished || !!view.winner;

  for (let day = 1; day <= maxDay; day += 1) {
    const dawn = view.publicLog.find((i) => i.day === day && i.kind === "dawn") ?? null;
    const dayItems = view.publicLog.filter(
      (i) => i.day === day && i.kind !== "dawn" && i.kind !== "finish",
    );
    const speeches = dayItems.filter((i) => i.kind === "speech").map((i) => i.seat).filter((s): s is number => s != null);
    const vote = view.voteHistory.find((v) => v.day === day && !v.pk) ?? null;
    // A night frame must show everyone already gone, not only tonight's victims.
    const nightDeaths = view.seats
      .filter(
        (s) =>
          s.death?.day != null &&
          (s.death.day < day ||
            (s.death.day === day && (s.death.cause === "wolf" || s.death.cause === "poison"))),
      )
      .map((s) => s.seat);
    const dayDeaths = view.seats
      .filter((s) => s.death?.day != null && s.death.day <= day)
      .map((s) => s.seat);
    const nightGod = view.godLog.filter((i) => i.day === day && NIGHT_KINDS.has(i.kind));
    const resolve = nightGod.find((i) => i.kind === "night.resolved");
    const nightActions = godView
      ? view.actions.filter((a) => a.day === day && NIGHT_FRAME_PHASES.has(a.phase))
      : [];
    const nightItems = [...nightActions.map(actionItem), ...(dawn ? [dawn] : [])].sort(
      (a, b) => a.seq - b.seq,
    );

    let nightCaption = view.live || finished ? "夜间进行中" : "夜间 · 已中断";
    if (godView && resolve) {
      nightCaption = resolve.text.replace(/^夜晚：/, "");
    } else if (dawn) {
      nightCaption = dawn.text.replace(/^天亮：/, "").replace(/^天亮:/, "");
    }
    if (!godView) {
      nightCaption = dawn ? (dawn.text.includes("平安夜") ? "平安夜" : dawn.text.replace(/^天亮：/, "")) : "天黑请闭眼";
    }

    frames.push({
      id: `n${day}`,
      kind: "night",
      day,
      no: `0${frames.length + 1}`.slice(-2),
      label: `N${day}`,
      title: `第 ${day} 夜`,
      sub: day === view.day && !dayPhase && !finished ? (view.live ? "进行中" : "已中断") : "已封存",
      caption: nightCaption,
      items: nightItems,
      godItems: nightGod,
      deaths: nightDeaths,
      speeches: [],
      vote: null,
    });

    if (day < view.day || dayPhase || finished) {
      const exile =
        vote?.exiled != null
          ? `${vote.exiled + 1}号放逐`
          : vote?.tie.length
            ? "平票 PK"
            : finished && day === view.day
              ? "终局"
              : "等待投票";
      const votingNow =
        day === view.day && !finished && (view.phase === "day_vote" || view.phase === "day_pk_vote");
      const eligible = votingNow
        ? view.seats.filter(
            (s) => s.alive && (view.phase !== "day_pk_vote" || !view.pk.includes(s.seat)),
          )
        : [];
      const cast = eligible.filter((s) => s.vote != null).length;
      frames.push({
        id: `d${day}`,
        kind: "day",
        day,
        no: `0${frames.length + 1}`.slice(-2),
        label: `D${day}`,
        title: `第 ${day} 天`,
        sub:
          day === view.day && dayPhase && !finished
            ? view.live
              ? PHASE_LABEL[view.phase] ?? "进行中"
              : "已中断"
            : "公开记录",
        caption: votingNow
          ? `${cast}/${eligible.length} 已投 · ${speeches.length} 发言`
          : `${speeches.length} 发言 · ${exile}`,
        items: dayItems,
        godItems: view.godLog.filter((i) => i.day === day),
        deaths: dayDeaths,
        speeches,
        vote,
      });
    }
  }

  if (finished) {
    const finish = view.publicLog.find((i) => i.kind === "finish") ?? null;
    const endDeaths = view.seats.filter((s) => s.death).map((s) => s.seat);
    frames.push({
      id: "end",
      kind: "end",
      day: view.day,
      no: `0${frames.length + 1}`.slice(-2),
      label: "END",
      title: "终局",
      sub: "封票",
      caption: view.winner?.name ? `${view.winner.name}胜` : "无胜者",
      items: [
        ...(finish ? [finish] : []),
        {
          seq: -1,
          day: view.day,
          text: `终局翻牌：${view.seats.map((s) => `${s.seat + 1}号${s.role ? ROLE_LABEL[s.role] : "?"}`).join("、")}`,
          tone: "ghost",
          kind: "roles",
        },
      ],
      godItems: view.godLog.filter((i) => i.kind === "finish" || i.kind === "died"),
      deaths: endDeaths,
      speeches: [],
      vote: null,
    });
  }

  return frames;
}

export function currentFrameId(view: TableState): string {
  if (view.finished || view.winner) return "end";
  if (view.phase === "dealing") return "n1";
  if (view.phase.startsWith("night")) return `n${Math.max(1, view.day)}`;
  return `d${Math.max(1, view.day)}`;
}

/**
 * Every spoken line a seat left in this frame, in order: day speech, PK speech,
 * last words. A seat that spoke and then left last words keeps both; collapsing
 * to the last item made the day speech disappear from the aside.
 */
export function frameSpeeches(view: TableState, frame: Frame, seat: number): TableLogItem[] {
  if (frame.kind !== "day") return [];
  return view.publicLog.filter(
    (i) =>
      i.seat === seat &&
      i.day === frame.day &&
      (i.kind === "last_words" ||
        (i.kind === "speech" &&
          (i.phase === undefined || i.phase === "day_speech" || i.phase === "day_pk_speech"))),
  );
}

/** The seat's latest spoken line in this frame; the aside shows all of them. */
export function frameSpeech(view: TableState, frame: Frame, seat: number): TableLogItem | null {
  return frameSpeeches(view, frame, seat).at(-1) ?? null;
}

/**
 * Every note a seat left inside this frame, in the order the moments happened.
 *
 * A day frame used to collapse to the last note, which meant a vote erased the
 * thought behind the speech that set the vote up. The aside reads like a small
 * diary instead: 发言前 → 投票时 → PK 重投时.
 */
export function frameThoughts(view: TableState, frame: Frame, seat: number): TableThought[] {
  const rows = view.thinkingHistory.filter((t) => t.seat === seat && t.day === frame.day);
  const picked =
    frame.kind === "night"
      ? rows.filter((t) => t.phase.startsWith("night"))
      : frame.kind === "day"
        ? rows.filter((t) => !t.phase.startsWith("night"))
        : rows;
  return picked
    .slice()
    .sort((a, b) => (THOUGHT_ORDER[a.phase] ?? 99) - (THOUGHT_ORDER[b.phase] ?? 99));
}

export function frameThought(view: TableState, frame: Frame, seat: number): TableThought | null {
  return frameThoughts(view, frame, seat).at(-1) ?? null;
}

/**
 * The decision ledger for a frame: one round per phase, one row per seat.
 *
 * `view.actions` carries the resolved moves; `thinkingHistory` carries the notes;
 * the live phase also has `seat.thinking` and `seat.action` before the tally.
 * Putting all three in one shape is what lets the table show "9 席正在投票"
 * instead of a single frozen vote count.
 */
export function decisionRounds(view: TableState, frame: Frame): DecisionRound[] {
  if (frame.kind === "end") return [];
  const phases = frame.kind === "night" ? NIGHT_DECISION_PHASES : DAY_DECISION_PHASES;
  const isCurrentFrame = frame.id === currentFrameId(view);
  const candidates = new Set(view.pk);
  const rounds: DecisionRound[] = [];

  for (const phase of phases) {
    const live = isCurrentFrame && view.phase === phase;
    const parallelVote = phase === "day_vote" || phase === "day_pk_vote";
    const rows: TableDecision[] = [];

    for (const seat of view.seats) {
      const archived = view.actions.find(
        (a) => a.day === frame.day && a.phase === phase && a.seat === seat.seat,
      );
      const thought = view.thinkingHistory.find(
        (t) => t.day === frame.day && t.phase === phase && t.seat === seat.seat,
      );
      const liveAction =
        live && seat.action
          ? actionFromContent({
              seq: 0,
              day: frame.day,
              phase,
              seat: seat.seat,
              content: seat.action,
            })
          : null;
      const note = thought?.text ?? (live ? seat.thinking : "");
      const native = thought?.native ?? (live ? seat.reasoning : "");
      const action = archived ?? liveAction;
      const thinking = live && seat.status === "thinking";
      // An AFK seat is never called again; its move is a forfeit, not a pending vote.
      const forfeit = live && (seat.status === "forfeit" || seat.afk);
      const hasData = !!action || !!note || !!native || thinking || forfeit;
      // A parallel vote should show the whole table, including the seats that
      // have not pressed the button yet. Sequential phases only grow as seats act.
      const waiting =
        live &&
        parallelVote &&
        seat.alive &&
        (phase === "day_vote" || !candidates.has(seat.seat));
      if (!hasData && !waiting) continue;

      rows.push({
        seat: seat.seat,
        phase,
        label: action?.label ?? (forfeit ? "弃权" : ""),
        target: action?.target ?? null,
        note,
        native,
        status: action ? "ready" : forfeit ? "forfeit" : thinking ? "thinking" : "waiting",
      });
    }

    if (rows.length === 0) continue;
    rounds.push({ phase, label: DECISION_ROUND_LABEL[phase] ?? phase, rows });
  }

  return rounds;
}

/** The seat's action for the frame being shown; replay keeps it, live shows it at once. */
export function seatActionFor(view: TableState, frame: Frame, seat: number): TableAction | null {
  if (frame.kind === "night") {
    return (
      view.actions
        .filter((a) => a.day === frame.day && a.seat === seat && NIGHT_ACTION_PHASES.has(a.phase))
        .at(-1) ?? null
    );
  }
  if (frame.kind === "day") {
    return (
      view.actions
        .filter((a) => a.day === frame.day && a.seat === seat && a.phase === "hunter_shot")
        .at(-1) ?? null
    );
  }
  return null;
}

/* ── seat status ───────────────────────────────────────────────────── */

export type StatusTone = "jade" | "amber" | "blue" | "red" | "faint";

function toneOf(action: TableAction): StatusTone {
  if (action.tone === "blood") return "red";
  if (action.tone === "amber") return "amber";
  if (action.tone === "ghost") return "blue";
  return "faint";
}

export function seatStatus(
  view: TableState,
  frame: Frame,
  seat: TableSeatView,
  currentId: string,
  showRole: boolean,
): { label: string; tone: StatusTone } {
  const isCurrent = frame.id === currentId;
  const deadHere = frame.deaths.includes(seat.seat);
  if (frame.kind === "end") {
    if (!deadHere) return { label: "存活", tone: "jade" };
    if (showRole && seat.death?.cause === "vote") return { label: "被放逐", tone: "red" };
    if (showRole && seat.death?.cause === "hunter") return { label: "被枪杀", tone: "red" };
    return { label: "出局", tone: "red" };
  }

  // A dead process cannot be thinking: every in-flight state (推演 / 发言 / 举枪 /
  // 遗言) is a `thinking` seat whose last event was a delta. Say so instead of
  // animating a thought that nobody is writing any more.
  if (isCurrent && !view.live && !view.finished && seat.status === "thinking") {
    return { label: "已中断", tone: "faint" };
  }

  // The dead only ever act twice: last words and the hunter's shot.
  if (deadHere) {
    const pullingTrigger =
      isCurrent &&
      view.phase === "hunter_shot" &&
      (seat.status === "thinking" || seat.status === "ready");
    if (pullingTrigger) return { label: "举枪中", tone: "red" };
    const givingWords =
      isCurrent &&
      view.phase === "day_last_words" &&
      (seat.status === "thinking" || seat.status === "ready");
    if (givingWords) return { label: "遗言中", tone: "amber" };
    if (showRole && seat.death?.cause === "vote") return { label: "被放逐", tone: "red" };
    if (showRole && seat.death?.cause === "hunter") return { label: "被枪杀", tone: "red" };
    return { label: "出局", tone: "red" };
  }

  if (isCurrent && view.speaking === seat.seat) {
    return view.phase === "day_last_words"
      ? { label: "遗言中", tone: "amber" }
      : { label: "发言中", tone: "jade" };
  }

  const acted = seatActionFor(view, frame, seat.seat);
  if (acted) {
    // The chip carries the verb; the card's action line carries the full label.
    if (!showRole) return { label: "已行动", tone: "blue" };
    return { label: acted.kind === "forfeit" ? "弃权" : acted.tag, tone: toneOf(acted) };
  }

  if (isCurrent && seat.status === "thinking") return { label: "推演中", tone: "amber" };
  if (isCurrent && seat.status === "forfeit") return { label: "弃权", tone: "amber" };
  if (seat.afk) return { label: "AFK", tone: "amber" };

  const vote = frame.vote?.votes[seat.seat] ?? (isCurrent && showRole ? seat.vote : null);
  if (vote != null) return { label: vote === "abstain" ? "弃票" : "已投票", tone: "blue" };
  if (frame.speeches.includes(seat.seat)) return { label: "已发言", tone: "blue" };
  if (isCurrent && seat.status === "ready") return { label: "已提交", tone: "blue" };
  return { label: "等待", tone: "faint" };
}
