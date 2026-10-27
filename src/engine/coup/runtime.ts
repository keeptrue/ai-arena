/**
 * Coup runtime: the only coup file allowed to touch providers, SQLite and the
 * event bus. The reducer stays pure; this file turns its effects into calls.
 */

import { nid } from "@/db/client";
import {
  appendEvent,
  createMatch,
  dropCheckpoint,
  getMatch,
  getMatchRoster,
  getModelRow,
  listModels,
  listProviders,
  loadCheckpoint,
  nextSeq,
  saveCheckpoint,
  setMatchStatus,
  snapshotModel,
  updateMatchUsage,
} from "@/db/repo";
import { publish } from "@/lib/bus";
import { getSecret } from "@/lib/secrets";
import { callWithRetry } from "@/providers";
import {
  MAX_THINKING_CHARS,
  REPEAT_LIMIT,
  REPEAT_WINDOW,
  STALL_MS,
  callTimeoutFor,
  forfeitReason,
  openCallWindow,
  shouldRetryStall,
  type CallCutInfo,
} from "../call-window";
import { createCacheGate, type CacheGate } from "../cache-gate";
import { SubmissionStreamParser } from "../parse";
import { openDeltaPump } from "../pump";
import { makeSeed, shuffle } from "../rng";
import { buildCommentaryPrompt, parseCommentary } from "./commentary";
import { applyTurnEvent, describeTurn, emptyTurn, type CoupTurnRecord } from "./turn";
import { buildSeatPrompt } from "./prompt";
import { startCoupReview } from "./review-runtime";
import { coerceCoupMove, coupSeatView, createCoupState, recoverCoup, reduceCoup } from "./reduce";
import type { ArenaEvent, ModelSnapshot, RecoverResult, Ruleset } from "../types";
import type { StartResult } from "../runtime";
import type {
  CoupAction,
  CoupBlueprint,
  CoupEffect,
  CoupMove,
  CoupPhase,
  CoupState,
  CoupSubmission,
} from "./types";

/* ── options ───────────────────────────────────────────────────────── */

export interface CoupSeatOption {
  modelId: string;
}

export interface CoupStartOptions {
  ruleset: Ruleset;
  spec: CoupBlueprint;
  seats?: CoupSeatOption[];
  seed?: string;
  budget?: { maxCalls: number; maxTokens: number };
  /** Audience-side narrator. Empty string / null keeps commentary off. */
  commentaryModelId?: string | null;
}

interface Ctx {
  id: string;
  state: CoupState;
  seq: number;
  stop: boolean;
  paused: boolean;
  pauseWaiters: Array<() => void>;
  inflight: Set<string>;
  models: ModelSnapshot[];
  /** One team per seat: Coup is a free-for-all. */
  teamIds: string[];
  checkpointBroken: boolean;
  cacheGate: CacheGate;
  /** The turn currently being narrated; null between turns. */
  turnDraft: CoupTurnRecord | null;
  /** Commentary runs one at a time so late replies cannot overtake new turns. */
  commentaryQueue: Promise<void>;
}

interface CoupCheckpoint {
  v: 1;
  paused: boolean;
  teamIds: string[];
  state: CoupState;
}

const SEAT_COLORS = ["#d4ab63", "#5faf8e", "#6f96c9", "#cf6f61"];

const contexts: Map<string, Ctx> = ((globalThis as { __arenaCoup?: Map<string, Ctx> }).__arenaCoup ??=
  new Map());

/* ── start ─────────────────────────────────────────────────────────── */

export async function startCoupMatch(options: CoupStartOptions): Promise<StartResult> {
  // The narrator is frozen into the snapshot: changing the ruleset later must not
  // silently swap who is talking over a match already in progress.
  const spec: CoupBlueprint = options.commentaryModelId
    ? { ...options.spec, commentary: { modelId: options.commentaryModelId } }
    : options.spec;
  const keyed = new Set(
    listProviders()
      .filter((p) => p.kind === "mock" || !!getSecret(p.id))
      .map((p) => p.id),
  );
  const rows = listModels().filter((m) => m.enabled && keyed.has(m.providerId));
  const contenders = rows.filter((m) => m.inContenderPool);

  if (!options.seats && contenders.length < 4) {
    throw new Error(`政变需要 4 个不同模型，当前可用 ${contenders.length} 个`);
  }
  if (options.seats && options.seats.length !== 4) {
    throw new Error(`政变需要正好 4 个座位，当前 ${options.seats.length} 个`);
  }

  // No explicit roster: draw four distinct models from the contender pool.
  const seed = options.seed?.trim() || makeSeed();
  const pool = shuffle(contenders, seed, "coup:roster");
  const picked = options.seats
    ? options.seats.map((seat) => {
        const row = contenders.find((m) => m.id === seat.modelId);
        if (!row) throw new Error(`模型不可用或未进选手池：${seat.modelId}`);
        return row;
      })
    : pool.slice(0, 4);
  // An explicit roster may repeat a model: a mirror table is legal (the launcher
  // labels those seats), and each seat keeps its own hand, coins and ballot.

  const snapshots = picked.map((m) => snapshotModel(m.id));
  const teams = snapshots.map((model, seat) => ({
    id: nid("t"),
    idx: seat,
    name: model.display,
    color: SEAT_COLORS[seat] ?? "#8a8577",
  }));
  const participants = snapshots.map((model, seat) => ({
    id: nid("p"),
    teamId: teams[seat].id,
    seat,
    model,
  }));

  const matchId = nid("m");
  const maxCalls = options.budget?.maxCalls ?? Math.min(400, 60 + 4 * 80);
  const budget = { maxCalls, maxTokens: options.budget?.maxTokens ?? 0 };

  createMatch({
    id: matchId,
    rulesetId: options.ruleset.id,
    blueprint: spec,
    seed,
    format: "4人",
    budget,
    judge: null,
    teams,
    participants,
  });

  const state = createCoupState({
    matchId,
    spec,
    seed,
    seats: participants.map((p, seat) => ({ participantId: p.id, seat })),
    budget,
    at: Date.now(),
  });

  const ctx: Ctx = {
    id: matchId,
    state,
    seq: nextSeq(matchId),
    stop: false,
    paused: false,
    pauseWaiters: [],
    inflight: new Set(),
    models: snapshots,
    teamIds: teams.map((t) => t.id),
    checkpointBroken: false,
    cacheGate: createCacheGate(),
    turnDraft: null,
    commentaryQueue: Promise.resolve(),
  };
  contexts.set(matchId, ctx);

  apply(ctx, { kind: "start", at: Date.now() });

  return {
    matchId,
    kind: "coup",
    seed,
    seats: participants.map((p, seat) => ({ seat, display: p.model.display })),
    judge: null,
  };
}

/* ── emit / dispatch ───────────────────────────────────────────────── */

function emitNow(ctx: Ctx, partial: Omit<ArenaEvent, "seq">): ArenaEvent {
  const event: ArenaEvent = { seq: ctx.seq++, ...partial };
  appendEvent(ctx.id, event);
  publish(ctx.id, event);
  observeTurn(ctx, event);
  return event;
}

const TURN_EVENTS = new Set<string>([
  "coup.action",
  "coup.reaction",
  "coup.block",
  "coup.challenge",
  "coup.lost",
  "coup.forfeit",
  "coup.coins",
  "coup.result",
  "coup.exchange",
  "coup.turn",
  "coup.finished",
]);

/**
 * Fold events into the current turn. `coup.turn` opens a new turn, so it is the
 * closing signal for the previous one — that is when the narrator speaks.
 */
function observeTurn(ctx: Ctx, event: ArenaEvent): void {
  if (!TURN_EVENTS.has(event.type)) return;
  if (event.type === "coup.action") {
    ctx.turnDraft = applyTurnEvent(emptyTurn(), event);
    return;
  }
  if (ctx.turnDraft) ctx.turnDraft = applyTurnEvent(ctx.turnDraft, event);
  if (event.type !== "coup.turn" && event.type !== "coup.finished") return;

  const record = ctx.turnDraft;
  ctx.turnDraft = null;
  if (!record || record.action === null) return;
  const finished = event.type === "coup.finished";
  const modelId = ctx.state.spec.commentary?.modelId;
  if (!modelId) return;
  ctx.commentaryQueue = ctx.commentaryQueue
    .then(() => runCommentary(ctx, modelId, record, finished))
    .catch(() => {});
}

/**
 * The narrator is audience-side: it reads every hand, so its output must never
 * reach a player prompt. That is why it writes its own event type and nothing else
 * consumes it. Fire-and-forget: a table without commentary is still a table.
 */
async function runCommentary(
  ctx: Ctx,
  modelId: string,
  record: CoupTurnRecord,
  finished: boolean,
): Promise<void> {
  const row = getModelRow(modelId);
  if (!row || !row.enabled) return;
  const model = snapshotModel(modelId);
  const apiKey = getSecret(model.providerId);
  if (!apiKey && model.kind !== "mock") return;
  const prompt = buildCommentaryPrompt({
    state: ctx.state,
    turn: record,
    finished,
  });
  try {
    const result = await callWithRetry(
      {
        model: { ...model, temperature: 0 },
        apiKey,
        system: prompt.system,
        messages: prompt.messages,
        json: true,
      },
      () => {},
    );
    const text = parseCommentary(result.text);
    if (!text) return;
    emitNow(ctx, {
      type: "coup.commentary",
      ts: Date.now(),
      payload: {
        turn: record.turn,
        text,
        model: model.display,
        latencyMs: result.latencyMs,
      },
    });
  } catch {
    /* silent: commentary is best-effort */
  }
}

function apply(ctx: Ctx, action: CoupAction): void {
  if (ctx.stop && action.kind !== "abort") return;
  const { state, effects } = reduceCoup(ctx.state, action);
  ctx.state = state;
  // Durability before dispatch: no seat may be called off a state that is not on disk.
  persistCheckpoint(ctx);
  for (const effect of effects) dispatch(ctx, effect);
}

function persistCheckpoint(ctx: Ctx): void {
  try {
    saveCheckpoint(ctx.id, "coup", {
      v: 1,
      paused: ctx.paused,
      teamIds: ctx.teamIds,
      state: ctx.state,
    } satisfies CoupCheckpoint);
  } catch {
    if (ctx.checkpointBroken) return;
    ctx.checkpointBroken = true;
    try {
      emitNow(ctx, {
        type: "anomaly",
        ts: Date.now(),
        payload: { code: "checkpoint_failed", message: "断点写入失败，重启后这一局无法续跑" },
      });
    } catch {
      /* the log is broken too */
    }
  }
}

function dispatch(ctx: Ctx, effect: CoupEffect): void {
  switch (effect.kind) {
    case "emit":
      emitNow(ctx, effect.event);
      return;
    case "call_seat": {
      const key = `${effect.phase}:${effect.seat}`;
      if (ctx.inflight.has(key)) return;
      ctx.inflight.add(key);
      void (async () => {
        try {
          await waitIfPaused(ctx);
          if (ctx.stop) return;
          if (ctx.state.budget.calls + 1 > ctx.state.budget.maxCalls) {
            apply(ctx, { kind: "abort", reason: "budget_exceeded" });
            return;
          }
          if (ctx.state.phase !== effect.phase) return;
          await runSeat(ctx, effect.seat, effect.phase);
        } finally {
          ctx.inflight.delete(key);
        }
      })();
      return;
    }
    case "finish":
      ctx.stop = true;
      finishNow(ctx, effect.winner, effect.reason);
      return;
  }
}

function finishNow(ctx: Ctx, winner: number | null, reason: string): void {
  ctx.stop = true;
  setMatchStatus(ctx.id, "finished", {
    winnerTeamId: winner !== null ? (ctx.teamIds[winner] ?? null) : null,
    endReason: reason,
  });
  updateMatchUsage(ctx.id, ctx.state.budget.calls, ctx.state.budget.tokens);
  // The terminal checkpoint is the review's only source of truth after the match
  // ends. Recovery refuses a finished match, so it cannot be rewound by accident.
  for (const wake of ctx.pauseWaiters.splice(0)) wake();
  if (!reason.startsWith("aborted:") && (ctx.state.spec.review?.enabled ?? true)) {
    const state = ctx.state;
    queueMicrotask(() => {
      void startCoupReview(ctx.id, { trigger: "auto", state }).catch(() => {});
    });
  }
  setTimeout(() => contexts.delete(ctx.id), 10 * 60 * 1000);
}

async function waitIfPaused(ctx: Ctx): Promise<void> {
  while (ctx.paused && !ctx.stop) {
    emitNow(ctx, { type: "state.updated", ts: Date.now(), payload: { paused: true } });
    await new Promise<void>((resolve) => ctx.pauseWaiters.push(resolve));
  }
}

/* ── one seat turn ─────────────────────────────────────────────────── */

async function runSeat(ctx: Ctx, seat: number, phase: CoupPhase): Promise<void> {
  const participant = ctx.state.seats.find((s) => s.seat === seat);
  if (!participant || !participant.alive) return;
  const model = ctx.models[seat];
  if (!model) return;

  const apiKey = getSecret(model.providerId);
  const started = Date.now();
  const base: CoupSubmission = {
    seat,
    phase,
    status: "ready",
    move: null,
    thinking: "",
    reasoning: "",
    raw: "",
    usage: { promptTokens: 0, completionTokens: 0 },
    latencyMs: 0,
    anomalies: [],
  };

  if (!apiKey && model.kind !== "mock") {
    submitSeat(ctx, { ...base, status: "forfeit", anomalies: ["missing_api_key"], latencyMs: Date.now() - started });
    return;
  }

  const prompt = buildSeatPrompt({ state: ctx.state, seat });
  const parser = new SubmissionStreamParser({ noteField: true });
  const emitDelta = (channel: "note" | "reason", delta: string, backedOff: boolean) => {
    // The native reasoning channel is the model's scratch pad: it is noisy,
    // often in another language, and it echoes the prompt back. It stays in the
    // checkpoint (submission.reasoning) and out of the audience stream.
    if (channel === "reason") return;
    emitNow(ctx, {
      type: "seat.thinking.delta",
      seat,
      ts: Date.now(),
      payload: { phase, seat, delta, channel, coarse: backedOff },
    });
  };
  const notePump = openDeltaPump((delta, meta) => emitDelta("note", delta, meta.backedOff));
  const reasonPump = openDeltaPump((delta, meta) => emitDelta("reason", delta, meta.backedOff));
  const stopPumps = () => {
    notePump.stop();
    reasonPump.stop();
  };

  const timeoutMs = callTimeoutFor(model);
  let callWindow = openCallWindow({ timeoutMs, stallMs: STALL_MS });
  let thinkingChars = 0;
  let nativeDump = "";
  let attemptChars = 0;
  const shingles = new Map<string, number>();
  let shingleBuf = "";
  const isLooping = (piece: string): boolean => {
    shingleBuf += piece;
    while (shingleBuf.length >= REPEAT_WINDOW) {
      const gram = shingleBuf.slice(0, REPEAT_WINDOW);
      shingleBuf = shingleBuf.slice(REPEAT_WINDOW / 2);
      const seen = (shingles.get(gram) ?? 0) + 1;
      shingles.set(gram, seen);
      if (seen >= REPEAT_LIMIT) return true;
    }
    return false;
  };
  const sink = (delta: { thinking?: string; text?: string }) => {
    callWindow.touch();
    if (delta.thinking) {
      thinkingChars += delta.thinking.length;
      attemptChars += delta.thinking.length;
      nativeDump += delta.thinking;
      reasonPump.push(delta.thinking);
      if (isLooping(delta.thinking)) callWindow.abort("loop");
    }
    if (delta.text) {
      const out = parser.push(delta.text);
      if (out) {
        thinkingChars += out.length;
        attemptChars += out.length;
        notePump.push(out);
        if (isLooping(out)) callWindow.abort("loop");
      }
    }
    if (MAX_THINKING_CHARS > 0 && thinkingChars > MAX_THINKING_CHARS) callWindow.abort("size");
  };

  let result;
  let lastCut: CallCutInfo | null = null;
  let stallRetries = 0;
  try {
    for (;;) {
      const window = callWindow;
      attemptChars = 0;
      try {
        result = await callWithRetry(
          {
            model,
            apiKey,
            system: prompt.system,
            messages: prompt.messages,
            signal: window.signal,
            onBeat: () => window.touch(),
          },
          sink,
          () => window.rearm(),
        );
        break;
      } catch (err) {
        const cut = window.cut();
        if (cut) {
          lastCut = { cut, elapsedMs: window.elapsedMs(), idleMs: window.idleMs(), timeoutMs };
        }
        window.close();
        if (!shouldRetryStall({ cut, receivedChars: attemptChars, retriesUsed: stallRetries })) {
          throw err;
        }
        stallRetries += 1;
        emitNow(ctx, {
          type: "anomaly",
          ts: Date.now(),
          payload: {
            phase,
            seat,
            code: "stall_retried",
            message: `${seat + 1} 号 ${Math.round(STALL_MS / 1000)} 秒没有收到任何内容，已重开一次`,
          },
        });
        callWindow = openCallWindow({ timeoutMs, stallMs: STALL_MS });
      }
    }
  } catch (err) {
    callWindow.close();
    stopPumps();
    const elapsed = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    submitSeat(ctx, {
      ...base,
      status: "forfeit",
      anomalies: [
        forfeitReason({
          cut: lastCut?.cut ?? callWindow.cut(),
          elapsedMs: elapsed,
          idleMs: lastCut?.idleMs ?? callWindow.idleMs(),
          timeoutMs,
          message,
        }),
      ],
      latencyMs: elapsed,
    });
    return;
  }
  callWindow.close();
  stopPumps();

  let fin = parser.finish();
  let fromNative = false;
  if (!fin.content && nativeDump.trim()) {
    const salvage = new SubmissionStreamParser({ noteField: true });
    salvage.push(nativeDump);
    const retried = salvage.finish();
    if (retried.content) {
      fin = retried;
      fromNative = true;
    }
  }
  const thinking = fin.thinking.trim();
  const nativeText = fromNative ? "" : result.thinking.trim();
  const reasoning = nativeText && nativeText !== thinking ? nativeText : "";

  if (!fin.content) {
    submitSeat(ctx, {
      ...base,
      status: "forfeit",
      thinking,
      reasoning,
      anomalies: fin.anomalies.length ? fin.anomalies : ["no_submission"],
      usage: result.usage,
      latencyMs: result.latencyMs,
      raw: result.text,
    });
    return;
  }

  let move = coerceCoupMove(phase, fin.content ?? {});
  let checked = move ? validateMove(ctx.state, seat, move) : null;
  if (!checked) {
    try {
      const retry = await callWithRetry(
        {
          model: { ...model, temperature: 0 },
          apiKey,
          system: prompt.system,
          messages: [
            ...prompt.messages,
            { role: "assistant" as const, content: result.text },
            {
              role: "user" as const,
              content: `你上一次的提交不合法。只输出修正后的 JSON，不要思考、不要解释。\n${JSON.stringify(fin.content)}`,
            },
          ],
          ...(Number.isFinite(timeoutMs) ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        },
        () => {},
      );
      const repairParser = new SubmissionStreamParser({ noteField: true });
      repairParser.push(retry.text);
      const repairFin = repairParser.finish();
      const repaired = coerceCoupMove(phase, repairFin.content ?? {});
      checked = repaired ? validateMove(ctx.state, seat, repaired) : null;
      if (checked) {
        move = repaired;
        submitSeat(ctx, {
          ...base,
          move: checked,
          thinking: thinking || repairFin.thinking,
          reasoning,
          usage: {
            promptTokens: result.usage.promptTokens + retry.usage.promptTokens,
            completionTokens: result.usage.completionTokens + retry.usage.completionTokens,
          },
          latencyMs: Date.now() - started,
          raw: retry.text,
          anomalies: [...fin.anomalies, ...repairFin.anomalies],
        });
        return;
      }
    } catch {
      /* fall through to forfeit */
    }
    submitSeat(ctx, {
      ...base,
      status: "forfeit",
      thinking,
      reasoning,
      anomalies: [...fin.anomalies, "invalid_move"],
      usage: result.usage,
      latencyMs: Date.now() - started,
      raw: result.text,
    });
    return;
  }

  submitSeat(ctx, {
    ...base,
    move: checked,
    thinking,
    reasoning,
    usage: result.usage,
    latencyMs: result.latencyMs,
    raw: result.text,
    anomalies: fin.anomalies,
  });
}

function submitSeat(ctx: Ctx, submission: CoupSubmission): void {
  ctx.state.budget.calls += 1;
  ctx.state.budget.tokens += submission.usage.promptTokens + submission.usage.completionTokens;
  apply(ctx, { kind: "submit", submission });
}

/** Reject moves the reducer would have to silently rewrite. */
function validateMove(state: CoupState, seat: number, move: CoupMove): CoupMove | null {
  const view = coupSeatView(state, seat);
  switch (move.kind) {
    case "act": {
      if (state.phase !== "action_select" || state.actor !== seat) return null;
      if (!view.legal.actions.includes(move.action)) return null;
      const needsTarget =
        move.action === "steal" || move.action === "assassinate" || move.action === "coup";
      if (needsTarget) {
        if (move.target === null || !view.legal.targets.includes(move.target)) return null;
      } else if (move.target !== null) {
        return null;
      }
      return move;
    }
    case "react": {
      if (state.phase !== "action_reaction" && state.phase !== "block_reaction") return null;
      if (!view.legal.reactions.includes(move.reaction)) return null;
      if (move.reaction === "block") {
        if (!move.as || !view.legal.blockRoles.includes(move.as)) return null;
      }
      return move;
    }
    case "flip": {
      if (state.phase !== "influence_lose") return null;
      if (!Number.isInteger(move.index) || move.index < 0 || move.index >= view.hand.length) return null;
      return move;
    }
    case "exchange": {
      if (state.phase !== "exchange_pick") return null;
      const pool = new Set([
        ...view.hand.map((c) => c.id),
        ...(state.pendingExchange?.drawn ?? []).map((c) => c.id),
      ]);
      const keep = move.keep.filter((id) => pool.has(id));
      const unique = Array.from(new Set(keep));
      if (unique.length !== view.hand.length) return null;
      return { kind: "exchange", keep: unique };
    }
    default:
      return null;
  }
}

/* ── interventions ─────────────────────────────────────────────────── */

export function interveneCoup(
  matchId: string,
  input: { kind: string; text?: string; teamId?: string; participantId?: string; seat?: number; delta?: number },
): { ok: boolean; error?: string; code?: string } | null {
  const ctx = contexts.get(matchId);
  if (!ctx) return null;
  if (ctx.stop) return { ok: false, error: "对局已结束" };

  if (input.kind === "recall") {
    const seat = Number(input.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= ctx.state.seats.length) {
      return { ok: false, code: "no_seat", error: "补叫需要指定 1–4 号座位" };
    }
    const target = ctx.state.seats.find((s) => s.seat === seat);
    if (!target || target.lastForfeitPhase !== ctx.state.phase || ctx.state.pending[seat] === undefined) {
      return {
        ok: false,
        code: "phase_advanced",
        error: "这一阶段已经推进或该座位没有被判弃权，补叫会让已有结论倒流",
      };
    }
    if (ctx.state.budget.calls + 1 > ctx.state.budget.maxCalls) {
      return { ok: false, code: "budget_exceeded", error: "调用预算不足，补叫会让这一局中止" };
    }
    emitNow(ctx, { type: "dm.intervened", ts: Date.now(), payload: { kind: "recall", seat } });
    apply(ctx, { kind: "recall", seat });
    return { ok: true };
  }

  if (input.kind === "pause") {
    ctx.paused = true;
    emitNow(ctx, { type: "dm.intervened", ts: Date.now(), payload: { kind: "pause" } });
    emitNow(ctx, { type: "state.updated", ts: Date.now(), payload: { paused: true } });
    persistCheckpoint(ctx);
    return { ok: true };
  }
  if (input.kind === "resume") {
    ctx.paused = false;
    emitNow(ctx, { type: "dm.intervened", ts: Date.now(), payload: { kind: "resume" } });
    emitNow(ctx, { type: "state.updated", ts: Date.now(), payload: { paused: false } });
    persistCheckpoint(ctx);
    for (const wake of ctx.pauseWaiters.splice(0)) wake();
    return { ok: true };
  }
  return { ok: false, error: "政变只支持暂停 / 继续 / 中止" };
}

export function abortCoupMatch(matchId: string, reason = "manual"): boolean {
  const ctx = contexts.get(matchId);
  if (!ctx) return false;
  apply(ctx, { kind: "abort", reason });
  return true;
}

export function coupLive(matchId: string): boolean {
  const ctx = contexts.get(matchId);
  return !!ctx && !ctx.stop;
}

/* ── crash recovery ────────────────────────────────────────────────── */

export function recoverCoupMatch(matchId: string): RecoverResult {
  const live = contexts.get(matchId);
  if (live && !live.stop) return { ok: true, already: true };
  if (live?.stop) return { ok: false, code: "finished", error: "对局已结束" };

  const checkpoint = loadCheckpoint(matchId);
  if (!checkpoint || checkpoint.kind !== "coup") {
    return { ok: false, code: "no_checkpoint", error: "这一局没有断点，无法续跑" };
  }
  const payload = checkpoint.payload as Partial<CoupCheckpoint> | null;
  const state = payload?.state;
  if (!state || state.matchId !== matchId || !Array.isArray(state.seats)) {
    return { ok: false, code: "corrupt", error: "断点已损坏，无法续跑" };
  }

  const match = getMatch(matchId);
  if (!match) return { ok: false, code: "not_found", error: "对局不存在" };
  const roster = getMatchRoster(matchId);

  if (state.phase === "done") {
    setMatchStatus(matchId, "finished", {
      winnerTeamId: state.winner !== null ? (payload?.teamIds?.[state.winner] ?? null) : null,
      endReason: state.endReason ?? "recovered_done",
    });
    updateMatchUsage(matchId, state.budget.calls, state.budget.tokens);
    dropCheckpoint(matchId);
    return { ok: false, code: "finished", error: "对局已结束" };
  }
  if (state.phase === "dealing") {
    return { ok: false, code: "corrupt", error: "断点停在开局前，无法续跑" };
  }

  const teamIds = payload.teamIds ?? roster.teams.map((t) => t.id);
  const models = roster.participants
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.model);

  const { state: next, effects } = recoverCoup(state);
  const ctx: Ctx = {
    id: matchId,
    state: next,
    seq: nextSeq(matchId),
    stop: false,
    paused: payload.paused === true,
    pauseWaiters: [],
    inflight: new Set(),
    models,
    teamIds,
    checkpointBroken: false,
    cacheGate: createCacheGate(),
    turnDraft: null,
    commentaryQueue: Promise.resolve(),
  };
  contexts.set(matchId, ctx);
  setMatchStatus(matchId, "running");
  updateMatchUsage(matchId, next.budget.calls, next.budget.tokens);

  const owed = effects.flatMap((effect) => (effect.kind === "call_seat" ? [effect.seat] : []));
  emitNow(ctx, {
    type: "match.recovered",
    ts: Date.now(),
    payload: {
      kind: "coup",
      turn: next.turn,
      phase: next.phase,
      paused: ctx.paused,
      owed,
      gapMs: 0,
    },
  });

  for (const effect of effects) dispatch(ctx, effect);
  return { ok: true };
}
