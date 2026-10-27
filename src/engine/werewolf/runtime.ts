/**
 * Werewolf runtime: the only werewolf file allowed to touch providers, SQLite and
 * the event bus. The reducer stays pure; this file turns its effects into calls.
 */

import { nid } from "@/db/client";
import {
  appendEvent,
  createMatch,
  dropCheckpoint,
  getMatchRoster,
  getModelRow,
  lastEventTs,
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
import { chooseJudge } from "../judge";
import { repairJson, SubmissionStreamParser } from "../parse";
import { makeSeed } from "../rng";
import {
  MAX_THINKING_CHARS,
  REPEAT_LIMIT,
  REPEAT_WINDOW,
  STALL_MS,
  callTimeoutFor,
  forfeitReason,
  openCallWindow,
  shouldRetryStall,
  type CallCut,
  type CallCutInfo,
} from "../call-window";
import { openDeltaPump } from "../pump";
import { validateDeal } from "./blueprint";
import { dealRoles } from "./deal";
import { buildJudgeDealPrompt, buildSeatPrompt } from "./prompt";
import { createCacheGate, gateKeyFor, type CacheGate } from "../cache-gate";
import { salvageSpeech } from "./speech";
import { startWerewolfReview } from "./review-runtime";
import {
  coerceWerewolfAction,
  createWerewolfState,
  recoverWerewolf,
  reduceWerewolf,
  validatePhaseAction,
} from "./reduce";
import type { ArenaEvent, ModelSnapshot, RecoverResult, Ruleset } from "../types";
import type { StartResult } from "../runtime";
import type {
  WerewolfAction,
  WerewolfBlueprint,
  WerewolfCamp,
  WerewolfDealMode,
  WerewolfEffect,
  WerewolfPhase,
  WerewolfRoleId,
  WerewolfState,
  WerewolfSubmission,
} from "./types";

/* ── options ───────────────────────────────────────────────────────── */

export interface WerewolfSeatOption {
  modelId: string;
}

export interface WerewolfDealOption {
  mode: WerewolfDealMode;
  roles?: WerewolfRoleId[];
}

export interface WerewolfStartOptions {
  ruleset: Ruleset;
  spec: WerewolfBlueprint;
  seats?: WerewolfSeatOption[];
  deal?: WerewolfDealOption;
  seed?: string;
  judgeModelId?: string | null;
  budget?: { maxCalls: number; maxTokens: number };
}

interface Ctx {
  id: string;
  state: WerewolfState;
  seq: number;
  stop: boolean;
  paused: boolean;
  pauseWaiters: Array<() => void>;
  inflight: Set<string>;
  campTeamIds: Record<WerewolfCamp, string>;
  models: ModelSnapshot[];
  /** Set once a checkpoint write fails, so the anomaly is logged once, not per turn. */
  checkpointBroken: boolean;
  /** Serializes the first call of a concurrent fan-out on write-charging caches. */
  cacheGate: CacheGate;
}

/** What a restart needs: the reducer state plus the two facts that live on the ctx. */
interface WerewolfCheckpoint {
  v: 1;
  paused: boolean;
  campTeamIds: Record<WerewolfCamp, string>;
  state: WerewolfState;
}

const G = globalThis as unknown as {
  __arenaWerewolf?: Map<string, Ctx>;
  __arenaRecovering?: Set<string>;
};
const contexts: Map<string, Ctx> = (G.__arenaWerewolf ??= new Map<string, Ctx>());
// Single-flight: a double-click must not start two recoveries for one match.
const recovering: Set<string> = (G.__arenaRecovering ??= new Set<string>());

export function getWerewolfContext(matchId: string): Ctx | undefined {
  return contexts.get(matchId);
}

const WOLF_COLOR = "#ff5a5a";
const GOOD_COLOR = "#37e0b0";

/* ── start ─────────────────────────────────────────────────────────── */

export async function startWerewolfMatch(options: WerewolfStartOptions): Promise<StartResult> {
  const spec = options.spec;
  const keyed = new Set(
    listProviders()
      .filter((p) => p.kind === "mock" || !!getSecret(p.id))
      .map((p) => p.id),
  );
  const rows = listModels().filter((m) => m.enabled && keyed.has(m.providerId));
  const contenders = rows.filter((m) => m.inContenderPool);

  if (!options.seats || options.seats.length !== 9) {
    throw new Error(`九人局需要正好 9 个座位，当前 ${options.seats?.length ?? 0} 个`);
  }

  const picked = options.seats.map((seat) => {
    const row = contenders.find((m) => m.id === seat.modelId);
    if (!row) throw new Error(`模型不可用或未进选手池：${seat.modelId}`);
    return row;
  });
  // The same model may hold more than one seat: a mirror table is legal (the
  // launcher labels those seats). Ballots, self-eval and forfeits are all keyed
  // by seat, so two seats of one model stay two independent seats.

  const seed = options.seed?.trim() || makeSeed();
  const dealMode: WerewolfDealMode = options.deal?.mode ?? "engine";
  // The referee is mandatory for the table — it is the tenth ballot of the
  // post-game review. It may also be one of the nine seated models: that model
  // then holds two ballots (its seat's and the judge's) and both count. Auto still
  // prefers a model that is not on the table, but an explicit pick wins.
  const judgeModel = resolveJudgeModel(
    options.judgeModelId ?? null,
    picked.map((m) => m.providerId),
    true,
  );
  if (!judgeModel) throw new Error("九人局需要一个裁判模型：去 /setups 给某个模型打开「裁判」");

  let roles: WerewolfRoleId[];
  let dealSource: WerewolfState["dealSource"];
  if (dealMode === "manual") {
    const manual = options.deal?.roles;
    if (!manual) throw new Error("手动发牌需要 9 张身份牌");
    const issues = validateDeal(spec, manual);
    if (issues.length) throw new Error(`手动发牌不合法：${issues.join("；")}`);
    roles = [...manual];
    dealSource = "manual";
  } else if (dealMode === "judge") {
    if (!judgeModel) throw new Error("法官发牌需要先选一个裁判模型");
    const dealt = await dealByJudge(judgeModel, spec, seed);
    roles = dealt.roles;
    dealSource = dealt.source;
  } else {
    roles = dealRoles(spec, seed);
    dealSource = "engine";
  }

  const wolfTeam = { id: nid("t"), idx: 0, name: "狼人阵营", color: WOLF_COLOR };
  const goodTeam = { id: nid("t"), idx: 1, name: "好人阵营", color: GOOD_COLOR };
  const campTeamIds: Record<WerewolfCamp, string> = { wolf: wolfTeam.id, good: goodTeam.id };

  const snapshots = picked.map((m) => snapshotModel(m.id));
  const participants = snapshots.map((model, seat) => {
    const role = roles[seat];
    const camp: WerewolfCamp = role === "wolf" ? "wolf" : "good";
    return {
      id: nid("p"),
      teamId: camp === "wolf" ? wolfTeam.id : goodTeam.id,
      seat,
      model,
    };
  });

  const matchId = nid("m");
  const maxCalls = Math.min(260, 9 * 3 * spec.rules.maxDays + 20);
  const budget = options.budget ?? { maxCalls, maxTokens: 0 };

  createMatch({
    id: matchId,
    rulesetId: options.ruleset.id,
    blueprint: spec,
    seed,
    format: "9人",
    budget,
    judge: judgeModel,
    teams: [wolfTeam, goodTeam],
    participants,
  });

  const state = createWerewolfState({
    matchId,
    spec,
    seed,
    dealSource,
    seats: participants.map((p, seat) => ({ participantId: p.id, seat, role: roles[seat] })),
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
    campTeamIds,
    models: snapshots,
    checkpointBroken: false,
    cacheGate: createCacheGate(),
  };
  contexts.set(matchId, ctx);

  apply(ctx, { kind: "start", at: Date.now() });
  if (dealSource === "engine_fallback") {
    emitNow(ctx, {
      type: "anomaly",
      ts: Date.now(),
      payload: { code: "judge_deal_fallback", message: "法官发牌失败，已用种子洗牌兜底" },
    });
  }

  return {
    matchId,
    kind: "werewolf",
    seed,
    seats: participants.map((p, seat) => ({
      seat,
      display: p.model.display,
      role: roles[seat],
    })),
    judge: judgeModel?.display ?? null,
  };
}

/**
 * The referee for a nine-seat table.
 *
 * Mandatory, but it may also be one of the nine seated models — a seat is allowed
 * to hold the judge ballot too. `planReviewRaters` still gives that model both
 * ballots, and the review prompt tells it which seat it is grading itself.
 */
function resolveJudgeModel(
  preferredId: string | null,
  contenderProviders: string[],
  required: boolean,
): ModelSnapshot | null {
  const preferred = preferredId?.trim() || null;
  const keyed = new Set(
    listProviders()
      .filter((p) => p.kind === "mock" || !!getSecret(p.id))
      .map((p) => p.id),
  );
  const candidates = listModels()
    .filter((m) => m.enabled && m.inJudgePool && keyed.has(m.providerId))
    .map((m) => ({ id: m.id, providerId: m.providerId, display: m.display }));
  const pick = chooseJudge(candidates, contenderProviders, preferred);
  if (pick.ok) return snapshotModel(pick.modelId);
  if (pick.reason === "empty_pool") {
    if (required) throw new Error("九人局需要一个裁判模型：去 /setups 给某个模型打开「裁判」");
    return null;
  }
  const row = preferred ? getModelRow(preferred) : null;
  if (!row) throw new Error(`裁判模型不存在：${preferred ?? "（空）"}`);
  if (!row.enabled) throw new Error(`裁判模型已停用：${row.display}`);
  throw new Error(`「${row.display}」不在裁判池：去 /setups 给它打开「裁判」`);
}

async function dealByJudge(
  judge: ModelSnapshot,
  spec: WerewolfBlueprint,
  seed: string,
): Promise<{ roles: WerewolfRoleId[]; source: "judge" | "engine_fallback" }> {
  const apiKey = getSecret(judge.providerId);
  if (!apiKey && judge.kind !== "mock") {
    return { roles: dealRoles(spec, seed), source: "engine_fallback" };
  }
  const prompt = buildJudgeDealPrompt({
    specName: spec.name,
    briefing: spec.briefing,
    seats: spec.seats,
    roles: spec.roles.map((r) => ({ label: r.label, count: r.count })),
  });
  let messages: Array<{ role: "user" | "assistant"; content: string }> = prompt.messages;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callWithRetry(
        { model: judge, apiKey, system: prompt.system, messages, json: true },
        () => {},
      );
      const parsed = JSON.parse(repairJson(result.text)) as {
        deal?: Array<{ seat?: unknown; role?: unknown }>;
      };
      if (!Array.isArray(parsed.deal) || parsed.deal.length !== 9) {
        throw new Error("deal 必须是 9 项");
      }
      const roles: Array<WerewolfRoleId | null> = Array(9).fill(null);
      for (const item of parsed.deal) {
        const seat = Number(item.seat);
        const role = String(item.role) as WerewolfRoleId;
        if (!Number.isInteger(seat) || seat < 1 || seat > 9) throw new Error(`座位号不合法：${item.seat}`);
        if (roles[seat - 1]) throw new Error(`座位 ${seat} 重复发牌`);
        if (!["wolf", "seer", "witch", "hunter", "villager"].includes(role)) {
          throw new Error(`身份不合法：${String(item.role)}`);
        }
        roles[seat - 1] = role;
      }
      if (roles.some((r) => !r)) throw new Error("有座位没有拿到身份");
      const issues = validateDeal(spec, roles as WerewolfRoleId[]);
      if (issues.length) throw new Error(issues.join("；"));
      return { roles: roles as WerewolfRoleId[], source: "judge" };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages = [
        ...prompt.messages,
        { role: "assistant" as const, content: lastError },
        {
          role: "user" as const,
          content: `上一版发牌不合法：${lastError}\n只输出修正后的 JSON，不要解释。`,
        },
      ];
    }
  }
  void lastError;
  return { roles: dealRoles(spec, seed), source: "engine_fallback" };
}

/* ── dispatch ──────────────────────────────────────────────────────── */

function emitNow(ctx: Ctx, partial: Omit<ArenaEvent, "seq">): ArenaEvent {
  const event: ArenaEvent = { seq: ctx.seq++, ...partial };
  appendEvent(ctx.id, event);
  publish(ctx.id, event);
  return event;
}

function apply(ctx: Ctx, action: WerewolfAction): void {
  if (ctx.stop && action.kind !== "abort") return;
  const { state, effects } = reduceWerewolf(ctx.state, action);
  ctx.state = state;
  // Durability before dispatch: no seat may be called off a state that is not on
  // disk, or a restart would let that seat act a second time.
  persistCheckpoint(ctx);
  for (const effect of effects) dispatch(ctx, effect);
}

/**
 * The rewind point for this match. Cheap enough to write on every transition
 * (one UPSERT of a JSON blob); dropped when the match ends.
 */
function persistCheckpoint(ctx: Ctx): void {
  try {
    saveCheckpoint(ctx.id, "werewolf", {
      v: 1,
      paused: ctx.paused,
      campTeamIds: ctx.campTeamIds,
      state: ctx.state,
    } satisfies WerewolfCheckpoint);
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
      /* the log is broken too; nothing left to report to */
    }
  }
}

function dispatch(ctx: Ctx, effect: WerewolfEffect): void {
  switch (effect.kind) {
    case "emit":
      emitNow(ctx, effect.event);
      return;
    case "call_seat": {
      // A wolf is called twice in one night (discuss, then decide). The stage keeps
      // the deciding call from being swallowed by the discussion call's in-flight key.
      const key = `${effect.phase}:${effect.seat}:${effect.stage ?? "main"}`;
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

function finishNow(ctx: Ctx, winner: WerewolfCamp | null, reason: string): void {
  ctx.stop = true;
  setMatchStatus(ctx.id, "finished", {
    winnerTeamId: winner ? ctx.campTeamIds[winner] : null,
    endReason: reason,
  });
  updateMatchUsage(ctx.id, ctx.state.budget.calls, ctx.state.budget.tokens, ctx.state.budget.cachedTokens ?? 0);
  // A finished match has nothing left to rewind to.
  try {
    dropCheckpoint(ctx.id);
  } catch {
    /* the row is harmless if it survives; recovery refuses a finished match anyway */
  }
  for (const wake of ctx.pauseWaiters.splice(0)) wake();
  // Post-game review, fire and forget: a table that cannot be scored is still a
  // finished table, so nothing here may throw into the finish path. The state is
  // handed over directly — the reducer's terminal snapshot is already on disk, but
  // this avoids re-parsing it while the ctx is still in hand.
  if (!reason.startsWith("aborted:") && (ctx.state.spec.review?.enabled ?? true)) {
    const state = ctx.state;
    queueMicrotask(() => {
      void startWerewolfReview(ctx.id, { trigger: "auto", state }).catch(() => {});
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

async function runSeat(ctx: Ctx, seat: number, phase: WerewolfPhase): Promise<void> {
  const participant = ctx.state.seats.find((s) => s.seat === seat);
  if (!participant || participant.afk) return;
  // The dead still speak last words and may pull a hunter's trigger; other phases are alive-only.
  if (!participant.alive && phase !== "day_last_words" && phase !== "hunter_shot") return;
  const model = ctx.models[seat];
  if (!model) return;

  const apiKey = getSecret(model.providerId);
  // 九个座位读的是同一个前缀。写入计费的缓存上，只允许第一个真去写，其余的等它。
  // 等的时间不算进看门狗：时钟在下面才启动。
  const gateKey = gateKeyFor(`ww:${phase}:${ctx.state.day}:${model.modelId}`, model);
  const releaseWarm = gateKey ? await ctx.cacheGate.acquire(gateKey) : () => {};

  const started = Date.now();
  const base: WerewolfSubmission = {
    seat,
    phase,
    status: "ready",
    action: null,
    thinking: "",
    reasoning: "",
    raw: "",
    usage: { promptTokens: 0, completionTokens: 0 },
    latencyMs: 0,
    anomalies: [],
  };

  if (!apiKey && model.kind !== "mock") {
    // Release before leaving: a keyless seat must not hold the rest of the table.
    releaseWarm();
    submitSeat(ctx, { ...base, status: "forfeit", anomalies: ["missing_api_key"], latencyMs: Date.now() - started });
    return;
  }

  const prompt = buildSeatPrompt({ state: ctx.state, seat });
  const parser = new SubmissionStreamParser({ noteField: true });
  // Two channels, two pumps: the audience note (protocol `<<<THINK>>>`) and the
  // provider's native reasoning must stay separable in the UI. Old clients that
  // only know `seat.thinking.delta` still work — `channel` defaults to "note".
  const emitDelta = (channel: "note" | "reason", delta: string, backedOff: boolean) => {
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
  /** Content received by the current attempt; a silence retry is only free when 0. */
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
  // A silence cut with nothing on the wire may be a dead gateway rather than a
  // dead model: re-open once on a fresh clock before giving the seat away.
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
            // Bytes on the wire keep a thinking seat alive even without a delta — and
            // they are the earliest proof that the prefix this seat shares is warm.
            onBeat: () => {
              releaseWarm();
              window.touch();
            },
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
    releaseWarm();
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
  releaseWarm();

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
  // `thinking` is the audience note: the submit JSON's `note` field, or a legacy
  // `<<<THINK>>>` draft when the model still writes one. `reasoning` is the
  // model's own channel. When the note was salvaged out of the reasoning stream,
  // they are the same text — keep it once, under the note.
  const thinking = fin.thinking.trim();
  const nativeText = fromNative ? "" : result.thinking.trim();
  const reasoning = nativeText && nativeText !== thinking ? nativeText : "";

  const speechPhase =
    phase === "day_speech" || phase === "day_pk_speech" || phase === "day_last_words";
  if (!fin.content) {
    // A broken payload must never become the speech: recover the line, not the
    // whole turn (markers + private reasoning + JSON).
    const speech = salvageSpeech(result.text);
    if (speechPhase && speech) {
      const text = speech.slice(0, phase === "day_last_words" ? 800 : 1200);
      const action =
        phase === "day_last_words"
          ? ({ kind: "last_words", text } as const)
          : ({ kind: "speech", text } as const);
      submitSeat(ctx, {
        ...base,
        action,
        thinking,
        reasoning,
        usage: result.usage,
        latencyMs: result.latencyMs,
        raw: result.text,
        anomalies: ["plain_text_speech"],
      });
      return;
    }
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

  const seatState = ctx.state.seats.find((s) => s.seat === seat)!;
  let action = coerceWerewolfAction(phase, fin.content);
  let checked = action ? validatePhaseAction(ctx.state, seatState, action) : null;
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
      const repaired = coerceWerewolfAction(phase, repairFin.content);
      checked = repaired ? validatePhaseAction(ctx.state, seatState, repaired) : null;
      if (checked) {
        action = repaired;
        submitSeat(ctx, {
          ...base,
          action: checked,
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
      anomalies: [...fin.anomalies, "invalid_action"],
      usage: result.usage,
      latencyMs: Date.now() - started,
      raw: result.text,
    });
    return;
  }

  submitSeat(ctx, {
    ...base,
    action: checked,
    thinking,
    reasoning,
    usage: result.usage,
    latencyMs: result.latencyMs,
    raw: result.text,
    anomalies: fin.anomalies,
  });

}

function submitSeat(ctx: Ctx, submission: WerewolfSubmission): void {
  apply(ctx, { kind: "submit", submission });
}

/* ── interventions ─────────────────────────────────────────────────── */

export function interveneWerewolf(
  matchId: string,
  input: { kind: string; text?: string; teamId?: string; participantId?: string; seat?: number; delta?: number },
): { ok: boolean; error?: string; code?: string } | null {
  const ctx = contexts.get(matchId);
  if (!ctx) return null;
  if (ctx.stop) return { ok: false, error: "对局已结束" };

  if (input.kind === "recall") {
    const seat = Number(input.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= ctx.state.seats.length) {
      return { ok: false, code: "no_seat", error: "补叫需要指定 1–9 号座位" };
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
    emitNow(ctx, {
      type: "dm.intervened",
      ts: Date.now(),
      payload: { kind: "recall", seat },
    });
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
  return { ok: false, error: "九人局只支持暂停 / 继续 / 中止" };
}

export function abortWerewolfMatch(matchId: string, reason = "manual"): boolean {
  const ctx = contexts.get(matchId);
  if (!ctx) return false;
  apply(ctx, { kind: "abort", reason });
  return true;
}

/** Is a live seat loop driving this match right now? */
export function werewolfLive(matchId: string): boolean {
  const ctx = contexts.get(matchId);
  return !!ctx && !ctx.stop;
}

/* ── crash recovery ────────────────────────────────────────────────── */

/**
 * Rebuild the ctx from the checkpoint and re-issue the calls the current phase
 * still owes. Seats that already answered are not called again — their actions
 * are in `state.pending`, and `recoverWerewolf` only asks for the missing ones.
 */
export function recoverWerewolfMatch(matchId: string): RecoverResult {
  const live = contexts.get(matchId);
  if (live && !live.stop) return { ok: true, already: true };
  if (live?.stop) return { ok: false, code: "finished", error: "对局已结束" };
  if (recovering.has(matchId)) return { ok: false, code: "busy", error: "恢复正在进行中" };

  recovering.add(matchId);
  try {
    const checkpoint = loadCheckpoint(matchId);
    if (!checkpoint || checkpoint.kind !== "werewolf") {
      return { ok: false, code: "no_checkpoint", error: "这一局没有断点，无法续跑" };
    }
    const payload = checkpoint.payload as Partial<WerewolfCheckpoint> | null;
    const state = payload?.state;
    if (!state || state.matchId !== matchId || !Array.isArray(state.seats)) {
      return { ok: false, code: "corrupt", error: "断点已损坏，无法续跑" };
    }
    // A checkpoint written before manual recall existed carries neither the
    // late-answer list nor a per-seat failure phase. Normalise, never refuse.
    state.recalled = Array.isArray(state.recalled) ? state.recalled : [];
    state.seats = state.seats.map((s) => ({ ...s, lastForfeitPhase: s.lastForfeitPhase ?? null }));

    const roster = getMatchRoster(matchId);
    const models = [...roster.participants].sort((a, b) => a.seat - b.seat).map((p) => p.model);
    if (models.length !== 9) return { ok: false, code: "corrupt", error: "断点缺少座位名单" };

    const campTeamIds: Record<WerewolfCamp, string> = payload?.campTeamIds ?? {
      wolf: roster.teams.find((t) => t.idx === 0)?.id ?? "",
      good: roster.teams.find((t) => t.idx === 1)?.id ?? "",
    };

    // A checkpoint written just before the process died can already be terminal.
    // Settle it instead of resurrecting a finished table.
    if (state.phase === "done") {
      setMatchStatus(matchId, "finished", {
        winnerTeamId: state.winner ? campTeamIds[state.winner] : null,
        endReason: state.endReason ?? "recovered_done",
      });
      updateMatchUsage(matchId, state.budget.calls, state.budget.tokens, state.budget.cachedTokens ?? 0);
      dropCheckpoint(matchId);
      // A checkpoint written just before the process died can be terminal. The
      // table is settled, but the review still owes its ten ballots; start it from
      // the recovered state instead of making the user notice a missing scoreboard.
      if (!(state.endReason ?? "").startsWith("aborted:") && (state.spec.review?.enabled ?? true)) {
        queueMicrotask(() => {
          void startWerewolfReview(matchId, { trigger: "auto", state }).catch(() => {});
        });
      }
      return { ok: false, code: "finished", error: "对局已结束" };
    }
    if (state.phase === "dealing") {
      return { ok: false, code: "corrupt", error: "断点停在校准阶段，无法续跑" };
    }

    // Resolve the phase before the ctx exists: a corrupt state must not leave a
    // half-live context behind.
    const { state: next, effects } = recoverWerewolf(state);
    const ctx: Ctx = {
      id: matchId,
      state: next,
      seq: nextSeq(matchId),
      stop: false,
      paused: payload?.paused === true,
      pauseWaiters: [],
      inflight: new Set(),
      campTeamIds,
      models,
      checkpointBroken: false,
      cacheGate: createCacheGate(),
    };
    contexts.set(matchId, ctx);
    setMatchStatus(matchId, "running");
    updateMatchUsage(matchId, next.budget.calls, next.budget.tokens, next.budget.cachedTokens ?? 0);

    const owed = effects.flatMap((effect) => (effect.kind === "call_seat" ? [effect.seat] : []));
    const gapMs = Math.max(0, Date.now() - (lastEventTs(matchId) ?? Date.now()));
    emitNow(ctx, {
      type: "match.recovered",
      ts: Date.now(),
      payload: { kind: "werewolf", day: next.day, phase: next.phase, paused: ctx.paused, owed, gapMs },
    });
    persistCheckpoint(ctx);
    for (const effect of effects) dispatch(ctx, effect);
    if (ctx.paused) {
      emitNow(ctx, { type: "state.updated", ts: Date.now(), payload: { paused: true } });
    }

    return { ok: true, resumed: true, day: next.day, phase: next.phase, owed };
  } catch (err) {
    return {
      ok: false,
      code: "corrupt",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    recovering.delete(matchId);
  }
}
