/**
 * Post-game review runtime.
 *
 * `review.ts` owns the scoring math; this file is the only review code allowed to
 * touch providers, SQLite and the event bus. It turns one finished table into a
 * set of ballots and one aggregated verdict.
 *
 * The review is deliberately decoupled from the match: it starts *after*
 * `match.finished`, writes its own events, and never touches the game state or the
 * game budget. A failed review costs ballots, never a match.
 */

import {
  addMatchUsage,
  appendEvent,
  eventsByType,
  getMatch,
  getMatchBlueprint,
  getMatchJudge,
  getMatchRoster,
  nextSeq,
} from "@/db/repo";
import { publish } from "@/lib/bus";
import { getSecret } from "@/lib/secrets";
import { callWithRetry } from "@/providers";
import { createCacheGate, gateKeyFor, type CacheGate } from "../cache-gate";
import { openDeltaPump, type DeltaMeta } from "../pump";
import {
  aggregateReview,
  buildReviewPacket,
  buildReviewPrompt,
  parseReviewBallot,
  planReviewRaters,
  resolveReviewRules,
  reviewAttempt,
  type ReviewBallot,
  type ReviewBallotBody,
  type ReviewPacket,
  type ReviewRules,
  type ReviewRater,
  type ReviewVerdict,
} from "./review";
import type { ArenaEvent, EventType, ModelSnapshot } from "../types";
import type { WerewolfBlueprint, WerewolfState } from "./types";

/* ── knobs ─────────────────────────────────────────────────────────── */

const REVIEW_TYPES: EventType[] = ["review.opened", "review.ballot", "review.verdict"];

/**
 * Everything `buildReviewPacket` can read. Reading the full stream would drag
 * every `seat.thinking.delta` chunk through memory (and they dwarf the facts);
 * the review only needs the public play-by-play. `state.snapshot` is fetched
 * separately by `loadFinalState`.
 */
const PACKET_TYPES: EventType[] = [
  "roles.dealt",
  "phase.changed",
  "wolf.chat",
  "seer.check",
  "night.resolved",
  "dawn",
  "speech",
  "vote.tally",
  "pk.opened",
  "exile",
  "no_exile",
  "hunter.shot",
  "last_words",
  "self_destruct",
  "seat.died",
  "seat.forfeit",
  "match.finished",
];
const STREAM_TYPES: EventType[] = [...REVIEW_TYPES, ...PACKET_TYPES];

const DEFAULT_CALL_TIMEOUT_MS = 180_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 360_000;
const DEFAULT_CONCURRENCY = 3;

/**
 * Ten ballots think at the same time, and a review is a form: the reasoning is
 * the interesting half, the JSON the boring half. Same cadence as a seat turn so
 * the panel typewrites instead of jumping, but a lower budget — after four
 * minutes of one ballot the stream backs off instead of flooding the log.
 */
const REVIEW_FLUSH_BUDGET = 240;

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/* ── process-wide singletons ───────────────────────────────────────── */

interface ReviewRunMeta {
  attempt: number;
  expected: number;
  trigger: ReviewTrigger;
  startedAt: number;
}

const G = globalThis as unknown as {
  __arenaReview?: Map<string, ReviewRunMeta>;
  __arenaReviewRunning?: Set<string>;
};

// Next.js gives every route its own module graph: a module-level Map would let a
// second POST start a duplicate review of the same table.
const runs: Map<string, ReviewRunMeta> = (G.__arenaReview ??= new Map<string, ReviewRunMeta>());
const running: Set<string> = (G.__arenaReviewRunning ??= new Set<string>());

/* ── public types ──────────────────────────────────────────────────── */

export type ReviewTrigger = "auto" | "manual";

export interface StartReviewOptions {
  trigger: ReviewTrigger;
  /** Re-run a review that already produced a verdict, or one that was aborted. */
  force?: boolean;
  /** The terminal reducer state, when the caller already holds it (auto trigger). */
  state?: WerewolfState;
}

export type ReviewStartStatus =
  | "running"
  | "already"
  | "not_found"
  | "aborted"
  | "disabled"
  | "not_ready"
  | "busy";

export interface ReviewStartResult {
  ok: boolean;
  status: ReviewStartStatus;
  attempt?: number;
  expected?: number;
  raters?: Rater[];
  verdict?: ReviewVerdict | null;
  error?: string;
}

export interface ReviewStatus {
  live: boolean;
  resumable: boolean;
  attempt: number;
  opened: boolean;
  verdict: ReviewVerdict | null;
  /** Only while a run is in flight. */
  expected?: number;
}

type Rater = number | "judge";

/* ── status ────────────────────────────────────────────────────────── */

/** Is a review loop scoring this match right now? */
export function werewolfReviewLive(matchId: string): boolean {
  return running.has(matchId);
}

/**
 * The review as the read routes see it. Derived from the event stream, never from
 * memory: a review survives the request that started it and a process restart
 * leaves no half-state behind.
 */
export function reviewStatus(matchId: string): ReviewStatus {
  const live = werewolfReviewLive(matchId);
  let attempt = 0;
  let opened = false;
  let verdict: ReviewVerdict | null = null;
  try {
    const replay = reviewAttempt(eventsByType(matchId, REVIEW_TYPES));
    attempt = replay.attempt;
    opened = replay.opened;
    verdict = replay.verdict;
  } catch {
    // A brand-new database may not have the events table yet; the review is simply not started.
  }
  const meta = runs.get(matchId);
  return {
    live,
    resumable: opened && !verdict && !live,
    attempt,
    opened,
    verdict,
    ...(live && meta ? { expected: meta.expected } : {}),
  };
}

/* ── start ─────────────────────────────────────────────────────────── */

/**
 * Kick off (or resume) the review of a finished nine-seat table.
 *
 * Returns as soon as the run is armed: ballots land as events, not in this
 * response. Manual callers get a 202-shaped result; the auto trigger ignores it.
 */
export async function startWerewolfReview(
  matchId: string,
  options: StartReviewOptions,
): Promise<ReviewStartResult> {
  if (running.has(matchId)) {
    return { ok: false, status: "busy", error: "这一局正在评分中，等它跑完或等 total timeout" };
  }

  const match = getMatch(matchId);
  if (!match || match.kind !== "werewolf") {
    return { ok: false, status: "not_found", error: "九人局不存在" };
  }
  if (match.status !== "finished") {
    return { ok: false, status: "not_ready", error: "对局还没结束，不能评分" };
  }
  const force = options.force === true;
  if ((match.endReason ?? "").startsWith("aborted:") && !force) {
    return { ok: false, status: "aborted", error: "对局是中止结束的；确认要评分请带 force" };
  }

  const blueprint = getMatchBlueprint(matchId);
  const frozenSpec = blueprint && blueprint.mode === "werewolf" ? blueprint : null;
  if (frozenSpec?.review?.enabled === false) {
    return { ok: false, status: "disabled", error: "本局规则关闭了赛后评分" };
  }

  const state = options.state ?? loadFinalState(matchId);
  if (!state || state.phase !== "done" || !Array.isArray(state.seats) || state.seats.length !== 9) {
    return { ok: false, status: "not_ready", error: "找不到终局状态（phase=done 且 9 座）" };
  }
  const stateSpec = state.spec as WerewolfBlueprint | undefined;
  const spec = stateSpec?.mode === "werewolf" ? stateSpec : frozenSpec;
  if (!spec) {
    return { ok: false, status: "not_ready", error: "缺少九人局蓝图快照，无法评分" };
  }
  if (spec.review?.enabled === false) {
    return { ok: false, status: "disabled", error: "本局规则关闭了赛后评分" };
  }

  // Type-filtered read: `seat.thinking.delta` chunks are the bulk of the stream and
  // the review never reads them. `reviewAttempt` ignores anything that is not a
  // `review.*` event, so one query feeds both the replay and the packet.
  const events = eventsByType(matchId, STREAM_TYPES);
  const previous = reviewAttempt(events);
  const attempt = force || previous.attempt === 0 ? Math.max(1, previous.attempt + 1) : previous.attempt;
  if (previous.verdict && !force) {
    return { ok: true, status: "already", attempt: previous.attempt, verdict: previous.verdict };
  }
  // A forced re-run opens a fresh attempt; a resumable one keeps the attempt it
  // already has and only calls the raters that never reached a terminal state.
  const opening = !previous.opened || attempt !== previous.attempt;

  const roster = getMatchRoster(matchId);
  const seatModels = new Map<number, ModelSnapshot>();
  for (const participant of roster.participants) seatModels.set(participant.seat, participant.model);
  if (seatModels.size !== 9) {
    return { ok: false, status: "not_ready", error: "座位名单不完整，无法评分" };
  }

  const judge = getMatchJudge(matchId);
  // A judge may also sit at this table: it then holds two ballots — its seat's and
  // the tenth, judge ballot — and both count. `judgeSeat` only tells the prompt
  // which seat the referee is grading itself, so the ballot is never dropped.
  const { raters, judgeSeat } = planReviewRaters(seatModels, judge);

  const rules = resolveReviewRules(spec);
  const terminal = new Set<string>(
    previous.terminal.map((rater) => raterKey(rater)),
  );
  const pending = opening
    ? raters
    : raters.filter((rater) => !terminal.has(raterKey(rater)));
  if (pending.length === 0) {
    // Every rater already reached a terminal state but the verdict never landed
    // (the process died between the last ballot and the aggregate). Settle it from
    // what is on disk; no model is called again.
    const recovered = aggregateBallots({
      state,
      rules,
      attempt,
      ballots: previous.ballots,
      missing: [],
      usage: { calls: 0, tokens: 0, cached: 0 },
    });
    recovered.reason = recovered.reason ?? "recovered";
    eventWriter(matchId, nextSeq(matchId))({
      type: "review.verdict",
      ts: Date.now(),
      payload: recovered as unknown as Record<string, unknown>,
    });
    return { ok: true, status: "already", attempt, verdict: recovered };
  }

  const packet = buildReviewPacket(state, events);
  const emit = eventWriter(matchId, nextSeq(matchId));
  const meta: ReviewRunMeta = {
    attempt,
    expected: raters.length,
    trigger: options.trigger,
    startedAt: Date.now(),
  };
  runs.set(matchId, meta);
  running.add(matchId);

  if (opening) {
    emit({
      type: "review.opened",
      ts: Date.now(),
      payload: {
        attempt,
        expected: raters.length,
        raters,
        rubric: rules as unknown as Record<string, unknown>,
      },
    });
  }
  if (judgeSeat !== null) {
    emit({
      type: "anomaly",
      ts: Date.now(),
      payload: {
        code: "review_judge_seated",
        message: `裁判与 ${judgeSeat + 1} 号座位是同一模型：座位票与裁判票都计入（裁判票按 ${rules.judgeVotes} 票）`,
      },
    });
  }

  void runReview({
    matchId,
    attempt,
    state,
    rules,
    packet,
    pending,
    seatModels,
    judge,
    judgeSeat,
    emit,
  })
    .catch(() => {
      /* a review never poisons the match; a missing verdict is visible in GET review */
    })
    .finally(() => {
      running.delete(matchId);
      if (runs.get(matchId)?.attempt === attempt) runs.delete(matchId);
    });

  return { ok: true, status: "running", attempt, expected: raters.length, raters };
}

/* ── one review run ────────────────────────────────────────────────── */

interface RunInput {
  matchId: string;
  attempt: number;
  state: WerewolfState;
  rules: ReviewRules;
  packet: ReviewPacket;
  pending: Rater[];
  seatModels: Map<number, ModelSnapshot>;
  judge: ModelSnapshot | null;
  /** The seat the judge also played, when the frozen judge is one of the nine models. */
  judgeSeat: number | null;
  emit: EventWriter;
}

interface RaterOutcome {
  rater: Rater;
  status: "ok" | "forfeit";
  ballot?: ReviewBallotBody;
  error?: string;
  calls: number;
  tokens: number;
  /** Input tokens a prefix cache served — a subset of `tokens`, for billing only. */
  cached: number;
}

async function runReview(input: RunInput): Promise<void> {
  const callTimeoutMs = envNumber("ARENA_REVIEW_CALL_TIMEOUT_MS", DEFAULT_CALL_TIMEOUT_MS);
  const totalTimeoutMs = envNumber("ARENA_REVIEW_TOTAL_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS);
  const concurrency = Math.max(
    1,
    Math.min(9, envNumber("ARENA_REVIEW_CONCURRENCY", DEFAULT_CONCURRENCY)),
  );
  const deadline = Date.now() + totalTimeoutMs;
  const total = new AbortController();
  const timer = setTimeout(() => total.abort(), totalTimeoutMs);

  const usage = { calls: 0, tokens: 0, cached: 0 };
  // All ballots read the same packet: on a write-charging cache only one may miss.
  const gate = createCacheGate();
  const ballots: ReviewBallot[] = [];
  const terminal = new Set<string>();
  const queue = [...input.pending];

  const record = (outcome: RaterOutcome): void => {
    usage.calls += outcome.calls;
    usage.tokens += outcome.tokens;
    usage.cached += outcome.cached;
    terminal.add(raterKey(outcome.rater));
    if (outcome.status === "ok" && outcome.ballot) {
      ballots.push({ ...outcome.ballot, rater: outcome.rater });
      input.emit({
        type: "review.ballot",
        ...(typeof outcome.rater === "number" ? { seat: outcome.rater } : {}),
        ts: Date.now(),
        payload: {
          attempt: input.attempt,
          rater: outcome.rater,
          status: "ok",
          ballot: outcome.ballot as unknown as Record<string, unknown>,
        },
      });
      return;
    }
    input.emit({
      type: "review.ballot",
      ...(typeof outcome.rater === "number" ? { seat: outcome.rater } : {}),
      ts: Date.now(),
      payload: {
        attempt: input.attempt,
        rater: outcome.rater,
        status: "forfeit",
        error: outcome.error ?? "unknown",
      },
    });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (total.signal.aborted) return;
      const rater = queue.shift();
      if (rater === undefined) return;
      const task = askRater({
        rater,
        packet: input.packet,
        rules: input.rules,
        gate,
        scope: `review:${input.matchId}:${input.attempt}`,
        model: rater === "judge" ? input.judge : (input.seatModels.get(rater) ?? null),
        judgeSeat: input.judgeSeat,
        callTimeoutMs,
        totalSignal: total.signal,
        attempt: input.attempt,
        emit: input.emit,
      }).catch(
        (err: unknown): RaterOutcome => ({
          rater,
          status: "forfeit",
          error: messageOf(err),
          calls: 0,
          tokens: 0,
          cached: 0,
        }),
      );
      const settled = await settleWithDeadline(task, deadline);
      if (!settled.done) {
        // The table's budget is spent: settle on the ballots already on the wire.
        total.abort();
        return;
      }
      // The deadline is a hard cap: a call still in flight stays missing. Only a
      // settled outcome reaches the ballot log; a late result is deliberately
      // dropped rather than arriving after the verdict has been written.
      if (settled.value.status === "ok" || !total.signal.aborted) record(settled.value);
    }
  };

  try {
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    await Promise.all(workers);
  } finally {
    clearTimeout(timer);
  }

  const missing = input.pending.filter((rater) => !terminal.has(raterKey(rater)));
  const verdict = aggregateBallots({
    state: input.state,
    rules: input.rules,
    attempt: input.attempt,
    ballots,
    missing,
    usage,
  });
  if (missing.length > 0 && !verdict.reason) verdict.reason = "partial";

  input.emit({
    type: "review.verdict",
    ts: Date.now(),
    payload: verdict as unknown as Record<string, unknown>,
  });

  // Review calls are billed to the match row, but never to the game's own budget:
  // the table was already decided before the first ballot was requested.
  try {
    addMatchUsage(input.matchId, usage.calls, usage.tokens, usage.cached);
  } catch {
    /* usage is bookkeeping; a failed write must not lose the verdict */
  }
}

/**
 * One place where ballots become a verdict. Used both by a live run and by the
 * crash-recovery path that settles a fully-voted attempt whose verdict never landed.
 */
function aggregateBallots(input: {
  state: WerewolfState;
  rules: ReviewRules;
  attempt: number;
  ballots: ReviewBallot[];
  missing: Rater[];
  usage: { calls: number; tokens: number; cached?: number };
}): ReviewVerdict {
  const players = input.ballots
    .filter((ballot): ballot is ReviewBallot & { rater: number } => typeof ballot.rater === "number")
    .sort((a, b) => a.rater - b.rater);
  const judgeBallot = input.ballots.find((ballot) => ballot.rater === "judge") ?? null;

  let verdict: ReviewVerdict;
  try {
    verdict = aggregateReview({
      state: input.state,
      ballots: players,
      judge: judgeBallot,
      rules: input.rules,
      missing: input.missing,
    });
  } catch {
    verdict = {
      attempt: input.attempt,
      weights: input.rules.weights,
      ranking: [],
      mvp: null,
      bestSpeech: null,
      bestDeception: null,
      provisional: true,
      judge: false,
      raters: { players: players.length, judge: !!judgeBallot, missing: input.missing },
      reason: "aggregate_failed",
    };
  }
  verdict.attempt = input.attempt;
  verdict.usage = { calls: input.usage.calls, tokens: input.usage.tokens, cached: input.usage.cached ?? 0 };
  return verdict;
}

/* ── one ballot ────────────────────────────────────────────────────── */

async function askRater(input: {
  rater: Rater;
  packet: ReviewPacket;
  rules: ReviewRules;
  gate: CacheGate;
  /** Shared by every ballot of one attempt; the model id namespaces it further. */
  scope: string;
  model: ModelSnapshot | null;
  judgeSeat: number | null;
  callTimeoutMs: number;
  totalSignal: AbortSignal;
  attempt: number;
  emit: EventWriter;
}): Promise<RaterOutcome> {
  const base = { rater: input.rater, calls: 0, tokens: 0, cached: 0 };
  const model = input.model;
  if (!model) return { ...base, status: "forfeit", error: "missing_model" };
  const apiKey = getSecret(model.providerId);
  if (!apiKey && model.kind !== "mock") {
    return { ...base, status: "forfeit", error: "missing_api_key" };
  }

  const gateKey = gateKeyFor(`${input.scope}:${model.modelId}`, model);
  const releaseWarm = gateKey ? await input.gate.acquire(gateKey) : () => {};

  // The panel groups review events by what they carry: a seat-scoped event keeps
  // `seat`, the tenth ballot carries neither. The stream follows the same rule.
  const scoped = typeof input.rater === "number" ? { seat: input.rater } : {};
  const emitDelta = (channel: "note" | "reason", delta: string, meta: DeltaMeta) => {
    input.emit({
      type: "review.thinking.delta",
      ...scoped,
      ts: Date.now(),
      payload: {
        attempt: input.attempt,
        rater: input.rater,
        channel,
        delta,
        ...(meta.backedOff ? { coarse: true } : {}),
      },
    });
  };
  // Announced only once the gate let this ballot through: what the audience sees
  // as "排队中" is a rater that was picked but has not started thinking yet.
  input.emit({
    type: "review.rater.started",
    ...scoped,
    ts: Date.now(),
    payload: { attempt: input.attempt, rater: input.rater },
  });

  const rater: ReviewRater =
    input.rater === "judge" ? { kind: "judge" } : { kind: "seat", seat: input.rater };
  const prompt = buildReviewPrompt({
    packet: input.packet,
    rater,
    rules: input.rules,
    judgeSeat: input.judgeSeat,
  });
  // Grading is a form: temperature 0 when the model accepts one at all.
  const reviewModel: ModelSnapshot = {
    ...model,
    temperature: model.supportsTemperature === false ? model.temperature : 0,
  };

  let calls = 0;
  let tokens = 0;
  let cached = 0;

  const call = async (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<{ text: string } | { error: string }> => {
    if (input.totalSignal.aborted) return { error: "timeout" };
    const controller = new AbortController();
    const onTotal = () => controller.abort();
    input.totalSignal.addEventListener("abort", onTotal);
    const timer = setTimeout(() => controller.abort(), input.callTimeoutMs);
    // Two channels, two pumps: the note is the ballot being written, the reason is
    // the model thinking. The panel shows them under different labels.
    const notePump = openDeltaPump(
      (delta, meta) => emitDelta("note", delta, meta),
      { budget: REVIEW_FLUSH_BUDGET },
    );
    const reasonPump = openDeltaPump(
      (delta, meta) => emitDelta("reason", delta, meta),
      { budget: REVIEW_FLUSH_BUDGET },
    );
    try {
      calls += 1;
      const result = await callWithRetry(
        {
          model: reviewModel,
          apiKey,
          system: prompt.system,
          messages,
          json: true,
          signal: controller.signal,
          onBeat: () => releaseWarm(),
        },
        (delta) => {
          if (delta.thinking) reasonPump.push(delta.thinking);
          if (delta.text) notePump.push(delta.text);
        },
      );
      tokens += result.usage.promptTokens + result.usage.completionTokens;
      cached += result.usage.cachedPromptTokens ?? 0;
      return { text: result.text };
    } catch (err) {
      return { error: controller.signal.aborted ? "timeout" : messageOf(err) };
    } finally {
      // `stop()` flushes the tail first: a ballot must never end mid-sentence.
      notePump.stop();
      reasonPump.stop();
      clearTimeout(timer);
      input.totalSignal.removeEventListener("abort", onTotal);
      releaseWarm();
    }
  };

  const first = await call(prompt.messages);
  if ("error" in first) return { ...base, calls, tokens, cached, status: "forfeit", error: first.error };

  const parsed = parseReviewBallot(first.text);
  if (parsed.ok) return { ...base, calls, tokens, cached, status: "ok", ballot: parsed.ballot };

  // One strict repair round: weak models answer a form with prose far too often.
  const repaired = await call([
    ...prompt.messages,
    { role: "assistant", content: first.text.slice(0, 4_000) },
    {
      role: "user",
      content: `你上一次的输出不是合法评分：${parsed.error}。按输出协议只给修正后的 JSON，不要解释、不要代码围栏。`,
    },
  ]);
  if ("error" in repaired) {
    return { ...base, calls, tokens, cached, status: "forfeit", error: repaired.error };
  }
  const second = parseReviewBallot(repaired.text);
  if (second.ok) return { ...base, calls, tokens, cached, status: "ok", ballot: second.ballot };
  return {
    ...base,
    calls,
    tokens,
    cached,
    status: "forfeit",
    error: `invalid_ballot:${second.error}`,
  };
}

/* ── plumbing ──────────────────────────────────────────────────────── */

type EventWriter = (partial: Omit<ArenaEvent, "seq">) => void;

/** One seq counter per run, seeded from the table's last event. Review events are serial. */
function eventWriter(matchId: string, startSeq: number): EventWriter {
  let seq = startSeq;
  return (partial) => {
    const event: ArenaEvent = { seq: seq++, ...partial };
    appendEvent(matchId, event);
    publish(matchId, event);
  };
}

function raterKey(rater: Rater): string {
  return rater === "judge" ? "judge" : `seat:${rater}`;
}

function messageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 160);
}

/** Resolve once the task settles, or report that the table's clock ran out first. */
async function settleWithDeadline<T>(
  task: Promise<T>,
  deadline: number,
): Promise<{ done: true; value: T } | { done: false }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { done: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), remaining);
  });
  try {
    return await Promise.race<{ done: true; value: T } | { done: false }>([
      task.then((value) => ({ done: true as const, value })),
      expired,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The terminal reducer state, read back from the snapshot the finish effect wrote. */
function loadFinalState(matchId: string): WerewolfState | null {
  let snapshots: ArenaEvent[];
  try {
    snapshots = eventsByType(matchId, ["state.snapshot"]);
  } catch {
    return null;
  }
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const raw: unknown = snapshots[i].payload.state;
    if (isFinalState(raw, matchId)) return raw;
  }
  return null;
}

function isFinalState(value: unknown, matchId: string): value is WerewolfState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<WerewolfState> & { spec?: { mode?: unknown } };
  return (
    state.matchId === matchId &&
    state.phase === "done" &&
    Array.isArray(state.seats) &&
    state.seats.length === 9 &&
    !!state.spec &&
    state.spec.mode === "werewolf"
  );
}
