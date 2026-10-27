/**
 * The runtime owns everything impure: provider calls, clock, database, fan-out.
 * The engine stays pure; this file turns its effects into reality.
 */

import { nid } from "@/db/client";
import {
  appendEvent,
  createMatch,
  dropCheckpoint,
  ensureSeedData,
  getMatch,
  getMatchRoster,
  getModelRow,
  getRulesetById,
  lastEventTs,
  listModels,
  listPromptOverrides,
  listProviders,
  listRulesets,
  loadCheckpoint,
  nextSeq,
  saveCheckpoint,
  saveJudgement,
  saveSubmission,
  setMatchStatus,
  snapshotModel,
  updateMatchUsage,
  updateTeamTotals,
} from "@/db/repo";
import { publish } from "@/lib/bus";
import { parseBoardState, parseMarks } from "@/lib/board";
import { getSecret } from "@/lib/secrets";
import { callWithRetry } from "@/providers";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_THINKING_CHARS,
  MIN_CALL_TIMEOUT_MS,
  MAX_CALL_TIMEOUT_MS,
  REPEAT_LIMIT,
  REPEAT_WINDOW,
  STALL_MS,
  callTimeoutFor,
  failureMessage,
  forfeitReason,
  openCallWindow,
  shouldRetryStall,
  type CallCut,
  type CallCutInfo,
} from "./call-window";
import {
  FLUSH_BUDGET,
  FLUSH_MAX_CHARS,
  FLUSH_MAX_INTERVAL_MS,
  FLUSH_MS,
  flushIntervalFor,
  openDeltaPump,
} from "./pump";
import { teamLetters, validateSubmission } from "./blueprint";
import { parseAnyBlueprint } from "./game";
import { startCoupMatch, recoverCoupMatch, interveneCoup, abortCoupMatch, coupLive } from "./coup/runtime";
import { abortWerewolfMatch, interveneWerewolf, recoverWerewolfMatch, startWerewolfMatch, werewolfLive } from "./werewolf/runtime";
import type { WerewolfRoleId } from "./werewolf/types";
import { chooseJudge } from "./judge";
import { applySettlement, outOfRange } from "./ledger";
import { SubmissionStreamParser, repairJson } from "./parse";
import { buildJudgePrompt, buildParticipantPrompt } from "./prompt";
import { isPromptKey, type PromptOverrides } from "./prompt-templates";
import { blindMapFor, budgetExhausted, createMatchState, recoverRound, reduce } from "./round";
import { makeSeed, shuffle } from "./rng";
import type {
  ArenaEvent,
  BoardSpec,
  Effect,
  Intervention,
  JudgeVerdict,
  MatchState,
  ModelSnapshot,
  ParticipantState,
  RecoverResult,
  Settlement,
  Submission,
  TeamScoreLine,
  TeamState,
  TokenUsage,
} from "./types";

/**
 * Calls stay bounded so a runaway loop cannot bill forever; tokens do not.
 * 0 = unlimited: the arena never imposes an input/output token ceiling.
 */
const DEFAULT_BUDGET = { maxCalls: 200, maxTokens: 0 };

const TEAM_PALETTE = [
  { name: "赤", color: "#ff6b52" },
  { name: "青", color: "#2fd3a8" },
  { name: "墨", color: "#8b9dff" },
  { name: "金", color: "#e0b855" },
  { name: "白", color: "#cfd6e4" },
  { name: "紫", color: "#c084fc" },
  { name: "灰", color: "#9aa2b1" },
  { name: "褐", color: "#c08a5a" },
];

export {
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_CALL_TIMEOUT_MS,
  MIN_CALL_TIMEOUT_MS,
  STALL_MS,
  STALL_RETRY,
  callTimeoutFor,
  shouldRetryStall,
  watchdogCut,
  forfeitReason,
} from "./call-window";
export {
  FLUSH_BUDGET,
  FLUSH_MAX_CHARS,
  FLUSH_MAX_INTERVAL_MS,
  FLUSH_MS,
  flushIntervalFor,
  openDeltaPump,
} from "./pump";

export interface StartOptions {
  rulesetId?: string;
  seed?: string;
  /** Explicit roster: each entry is one side. */
  teams?: Array<{ name?: string; modelIds: string[] }>;
  /** Random roster: how many models per side. */
  teamSizes?: number[];
  /** Which model referees: a `models.id` from the judge pool. Omitted = auto. */
  judgeModelId?: string | null;
  budget?: { maxCalls: number; maxTokens: number };
  /**
   * Werewolf / coup table: one model per seat. The same model may hold more than
   * one seat (a mirror table) — the launcher labels those seats instead of
   * blocking them.
   */
  seats?: Array<{ modelId: string }>;
  /** Nine-seat table: engine shuffle, manual roles, or judge deal. */
  deal?: { mode: "engine" | "manual" | "judge"; roles?: WerewolfRoleId[] };
  /** Coup: the audience-side narrator; omitted or empty keeps it off. */
  commentaryModelId?: string | null;
}

interface Ctx {
  id: string;
  state: MatchState;
  seq: number;
  stop: boolean;
  pauseWaiters: Array<() => void>;
  queue: Intervention[];
  /** say/rule interventions, carried into every subsequent prompt. */
  said: Intervention[];
  warnedJudge: boolean;
  /** Set once a checkpoint write fails, so the anomaly is logged once, not per turn. */
  checkpointBroken: boolean;
}

/** What a restart needs: the reducer state plus the ctx-only bits. */
interface RubricCheckpoint {
  v: 1;
  said: Intervention[];
  warnedJudge: boolean;
  state: MatchState;
}

// Next.js gives each route its own module graph; park live state on globalThis.
const G = globalThis as unknown as {
  __arenaRuntime?: Map<string, Ctx>;
  __arenaBooted?: boolean;
  __arenaBoot?: Promise<void>;
  __arenaRecovering?: Set<string>;
};
const contexts: Map<string, Ctx> = (G.__arenaRuntime ??= new Map<string, Ctx>());
const recovering: Set<string> = (G.__arenaRecovering ??= new Set<string>());

export function getContext(matchId: string): Ctx | undefined {
  return contexts.get(matchId);
}

/* ── event plumbing ────────────────────────────────────────────────── */

function emitNow(ctx: Ctx, partial: Omit<ArenaEvent, "seq">): ArenaEvent {
  const event: ArenaEvent = { seq: ctx.seq++, ...partial };
  appendEvent(ctx.id, event);
  publish(ctx.id, event);
  return event;
}

/* ── roster selection ──────────────────────────────────────────────── */

function keyedProviders(): Set<string> {
  return new Set(
    listProviders()
      .filter((p) => p.kind === "mock" || !!getSecret(p.id))
      .map((p) => p.id),
  );
}

function usableModels(keyed: Set<string>) {
  return listModels().filter((m) => m.enabled && keyed.has(m.providerId));
}

/**
 * The referee is chosen at match creation and then frozen into the match, so a
 * later pool edit cannot change who is judging a match already under way.
 *
 * An explicit pick wins, but only inside the judge pool — that pool is the user's
 * statement of which models may referee. Without a pick the heuristic stays
 * unchanged: prefer a vendor that is not on the roster.
 */
function resolveJudge(
  contenders: ModelSnapshot[],
  preferredId: string | null,
  keyed: Set<string>,
): ModelSnapshot | null {
  const candidates = listModels()
    .filter((m) => m.enabled && m.inJudgePool && keyed.has(m.providerId))
    .map((m) => ({ id: m.id, providerId: m.providerId, display: m.display }));

  const pick = chooseJudge(
    candidates,
    contenders.map((c) => c.providerId),
    preferredId,
  );
  if (pick.ok) return snapshotModel(pick.modelId);
  if (pick.reason === "empty_pool") return null;

  // An explicit id that is not an eligible judge: say exactly what is missing.
  const row = preferredId ? getModelRow(preferredId) : null;
  if (!row) throw new Error(`裁判模型不存在：${preferredId ?? "（空）"}`);
  if (!row.enabled) throw new Error(`裁判模型已停用：${row.display}`);
  if (!keyed.has(row.providerId)) throw new Error(`${row.providerName} 还没填 Key，不能当裁判`);
  throw new Error(`「${row.display}」不在裁判池：去 /setups 给它打开「裁判」`);
}

/* ── match creation ────────────────────────────────────────────────── */

export interface StartResult {
  matchId: string;
  kind: "rubric" | "werewolf" | "coup";
  seed: string;
  teams?: Array<{
    id: string;
    name: string;
    color: string;
    members: Array<{ seat: number; display: string }>;
  }>;
  seats?: Array<{ seat: number; display: string; role?: WerewolfRoleId }>;
  judge: string | null;
}

export async function startMatch(options: StartOptions = {}): Promise<StartResult> {
  ensureSeedData();

  const rulesets = listRulesets().filter((r) => r.enabled);
  const ruleset = options.rulesetId ? getRulesetById(options.rulesetId) : rulesets[0];
  if (!ruleset) throw new Error("没有可用的规则：先去 /rulesets 写一条，或启用内置规则");
  const blueprint = parseAnyBlueprint(ruleset.blueprint);
  if (blueprint.mode === "coup") {
    return startCoupMatch({
      ruleset,
      spec: blueprint,
      seats: options.seats,
      seed: options.seed,
      budget: options.budget,
      commentaryModelId: options.commentaryModelId,
    });
  }
  if (blueprint.mode === "werewolf") {
    return startWerewolfMatch({
      ruleset,
      spec: blueprint,
      seats: options.seats,
      deal: options.deal,
      seed: options.seed,
      judgeModelId: options.judgeModelId,
      budget: options.budget,
    });
  }
  const seed = options.seed?.trim() || makeSeed();

  const keyed = keyedProviders();
  const usable = usableModels(keyed);
  const contenders = usable.filter((m) => m.inContenderPool);
  // An explicit roster may put one model on every seat (a mirror duel); only the
  // random draw below needs two models in the pool.
  const explicitRoster = !!options.teams && options.teams.length >= 2;
  if (!explicitRoster && contenders.length < 2) {
    throw new Error("至少需要两个可用的选手模型：去 /setups 填 Key 并拉取模型，或启用本地演练体");
  }

  /* resolve roster */
  let teamSpecs: Array<{ name?: string; modelIds: string[] }>;
  if (explicitRoster && options.teams) {
    teamSpecs = options.teams;
  } else {
    const sizes = options.teamSizes?.length ? options.teamSizes : [1, 1];
    const seatCount = sizes.reduce((a, b) => a + b, 0);
    // Real models first; rehearsal models only fill in when there is nothing else.
    const realPool = contenders.filter((m) => m.providerId !== "mock");
    const pool = realPool.length >= seatCount ? realPool : contenders;
    const drawn = shuffle(pool, seed, "roster").slice(0, seatCount);
    if (drawn.length < seatCount) throw new Error(`可用模型不足：需要 ${seatCount} 个，只有 ${drawn.length} 个`);
    let cursor = 0;
    teamSpecs = sizes.map((size) => {
      const slice = drawn.slice(cursor, cursor + size);
      cursor += size;
      return { name: "", modelIds: slice.map((m) => m.id) };
    });
  }

  const seatCount = teamSpecs.reduce((acc, t) => acc + t.modelIds.length, 0);
  if (teamSpecs.length < 2) throw new Error("至少要两方");
  if (seatCount > 8) throw new Error("总席位上限是 8");
  for (const t of teamSpecs) {
    if (t.modelIds.length < 1) throw new Error("每方至少 1 个模型");
    if (t.modelIds.length > 4) throw new Error("每方最多 4 个模型");
    for (const id of t.modelIds) {
      const row = contenders.find((m) => m.id === id);
      if (!row) throw new Error(`模型不可用或未进选手池: ${id}`);
    }
  }

  const modelSnapshots = new Map<string, ModelSnapshot>();
  for (const t of teamSpecs) for (const id of t.modelIds) modelSnapshots.set(id, snapshotModel(id));

  // A declared ledger addresses exactly two sides, one submission each. Anything else
  // would fall back to judge arithmetic *and* silently zero the derived dimensions —
  // refuse up front instead of producing a match with no scoreboard.
  if (blueprint.board?.settle) {
    const seats = teamSpecs.map((t) => t.modelIds.length);
    if (teamSpecs.length !== 2 || seats.some((n) => n !== 1)) {
      throw new Error(
        `规则「${blueprint.name}」的账本按两方各 1 人结算，这局是 ${teamSpecs.length} 方（${seats.join("+")} 人）。换一条规则，或把阵容改成 1v1。`,
      );
    }
  }

  const judgeModel = resolveJudge(
    [...modelSnapshots.values()],
    options.judgeModelId?.trim() || null,
    keyed,
  );

  const matchId = nid("m");
  const budget =
    options.budget ??
    {
      maxCalls: Math.min(DEFAULT_BUDGET.maxCalls, blueprint.rounds * (seatCount + 1) + 6),
      maxTokens: DEFAULT_BUDGET.maxTokens,
    };

  const teams: TeamState[] = teamSpecs.map((t, i) => {
    const palette = TEAM_PALETTE[i % TEAM_PALETTE.length];
    return {
      id: nid("t"),
      name: t.name?.trim() || `${palette.name}方`,
      color: palette.color,
      idx: i,
      memberIds: [],
      roundScore: 0,
      totalScore: 0,
      forfeits: 0,
    };
  });

  const participants: ParticipantState[] = [];
  let seat = 0;
  teamSpecs.forEach((spec, teamIdx) => {
    const team = teams[teamIdx];
    spec.modelIds.forEach((modelRowId) => {
      const participant: ParticipantState = {
        id: nid("p"),
        seat,
        teamId: team.id,
        model: modelSnapshots.get(modelRowId)!,
        status: "idle",
        forfeits: 0,
      };
      participants.push(participant);
      team.memberIds.push(participant.id);
      seat += 1;
    });
  });

  createMatch({
    id: matchId,
    rulesetId: ruleset.id,
    blueprint,
    seed,
    format: teamSpecs.map((t) => t.modelIds.length).join("v"),
    budget,
    judge: judgeModel,
    teams: teams.map((t) => ({ id: t.id, idx: t.idx, name: t.name, color: t.color })),
    participants: participants.map((p) => ({
      id: p.id,
      teamId: p.teamId,
      seat: p.seat,
      model: p.model,
    })),
  });

  const state = createMatchState({
    matchId,
    rulesetId: ruleset.id,
    blueprint,
    seed,
    teams,
    participants,
    judgeModel,
    budget,
    at: Date.now(),
  });

  const ctx: Ctx = {
    id: matchId,
    state,
    seq: nextSeq(matchId),
    stop: false,
    pauseWaiters: [],
    queue: [],
    said: [],
    warnedJudge: false,
    checkpointBroken: false,
  };
  contexts.set(matchId, ctx);

  apply(ctx, { kind: "start", at: Date.now() });

  return {
    matchId,
    kind: "rubric",
    seed,
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      members: participants
        .filter((p) => p.teamId === t.id)
        .map((p) => ({ seat: p.seat, display: p.model.display })),
    })),
    judge: judgeModel?.display ?? null,
  };
}

/* ── dispatch ──────────────────────────────────────────────────────── */

/**
 * Applies an action and dispatches its effects. Deliberately synchronous: model
 * calls are fired and their completions re-enter through `apply`, so there is no
 * await inside a state transition and therefore no interleaving.
 */
function apply(ctx: Ctx, action: Parameters<typeof reduce>[1]): void {
  if (ctx.stop && action.kind !== "abort") return;
  drainQueue(ctx);

  const { state, effects } = reduce(ctx.state, action);
  ctx.state = state;
  // Durability before dispatch: no seat may be called off a state that is not on
  // disk, or a restart would let that seat submit twice.
  persistCheckpoint(ctx);

  for (const effect of effects) dispatch(ctx, effect);
}

/** The rewind point for this match; dropped when the match ends. */
function persistCheckpoint(ctx: Ctx): void {
  try {
    saveCheckpoint(ctx.id, "rubric", {
      v: 1,
      said: ctx.said,
      warnedJudge: ctx.warnedJudge,
      state: ctx.state,
    } satisfies RubricCheckpoint);
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

function dispatch(ctx: Ctx, effect: Effect): void {
  switch (effect.kind) {
    case "emit":
      emitNow(ctx, effect.event);
      return;

    case "call_participants": {
      void (async () => {
        await waitIfPaused(ctx);
        if (ctx.stop) return;
        if (budgetExhausted(ctx.state.budget)) {
          apply(ctx, { kind: "abort", reason: "budget_exceeded" });
          return;
        }
        await Promise.all(effect.ids.map((id) => runParticipant(ctx, id)));
      })();
      return;
    }

    case "call_judge": {
      void (async () => {
        await waitIfPaused(ctx);
        if (ctx.stop) return;
        const verdict = await runJudge(ctx, effect.round, effect.sudden, effect.settlement ?? null);
        if (!verdict) {
          // Never fabricate a verdict. Bank what was actually earned — and if
          // nothing has been scored yet, declare no winner rather than team 0.
          const ranked = [...ctx.state.teams].sort((a, b) => b.totalScore - a.totalScore);
          const winner = ranked[0] && ranked[0].totalScore > 0 ? ranked[0].id : null;
          finishNow(ctx, winner, "judge_failed");
          return;
        }
        apply(ctx, { kind: "verdict", verdict });
      })();
      return;
    }

    case "finish":
      ctx.stop = true;
      finishNow(ctx, effect.winnerTeamId, effect.reason);
      return;
  }
}

function finishNow(ctx: Ctx, winnerTeamId: string | null, reason: string): void {
  ctx.stop = true;
  setMatchStatus(ctx.id, "finished", { winnerTeamId, endReason: reason });
  updateMatchUsage(ctx.id, ctx.state.budget.calls, ctx.state.budget.tokens, ctx.state.budget.cachedTokens ?? 0);
  updateTeamTotals(ctx.id, ctx.state.teams);
  // A finished match has nothing left to rewind to.
  try {
    dropCheckpoint(ctx.id);
  } catch {
    /* the row is harmless: recovery refuses a finished match anyway */
  }
  setTimeout(() => contexts.delete(ctx.id), 10 * 60 * 1000);
}

/* ── pause / interventions ─────────────────────────────────────────── */

async function waitIfPaused(ctx: Ctx): Promise<void> {
  drainQueue(ctx);
  while (ctx.state.paused && !ctx.stop) {
    emitNow(ctx, { type: "state.updated", ts: Date.now(), payload: { paused: true } });
    await new Promise<void>((resolve) => ctx.pauseWaiters.push(resolve));
    drainQueue(ctx);
  }
}

function drainQueue(ctx: Ctx): void {
  if (ctx.queue.length === 0) return;
  const pending = ctx.queue.splice(0, ctx.queue.length);
  for (const intervention of pending) {
    const { state } = reduce(ctx.state, { kind: "dm", intervention });
    ctx.state = state;
    if (intervention.kind === "say" || intervention.kind === "rule") ctx.said.push(intervention);
    if (intervention.kind === "resume") {
      ctx.state = { ...ctx.state, paused: false };
      for (const wake of ctx.pauseWaiters.splice(0)) wake();
    }
  }
}

export function intervene(
  matchId: string,
  input: {
    kind: Intervention["kind"];
    text?: string;
    teamId?: string;
    participantId?: string;
    seat?: number;
    delta?: number;
  },
): { ok: boolean; error?: string; code?: string } {
  const werewolf = interveneWerewolf(matchId, input);
  if (werewolf) return werewolf;
  const coup = interveneCoup(matchId, input);
  if (coup) return coup;
  const ctx = contexts.get(matchId);
  if (!ctx) return { ok: false, code: "not_running", error: "对局不在运行中" };
  if (ctx.stop) return { ok: false, code: "finished", error: "对局已结束" };

  // A recall is a state transition with a call attached, not a note for the DM log:
  // push it through `apply` so the checkpoint lands before the seat is called again.
  if (input.kind === "recall") {
    const participantId = input.participantId;
    const submission = participantId ? ctx.state.pending[participantId] : undefined;
    if (!participantId || !submission || submission.status !== "forfeit") {
      return { ok: false, code: "already_settled", error: "这个座位本轮没有可回滚的弃权" };
    }
    if (ctx.state.phase !== "collecting" && ctx.state.phase !== "sudden") {
      return { ok: false, code: "phase_advanced", error: "本轮已经裁决，补叫会让结论倒流" };
    }
    if (ctx.state.budget.calls + 1 > ctx.state.budget.maxCalls) {
      return { ok: false, code: "budget_exceeded", error: "调用预算不足，补叫会让这一局中止" };
    }
    emitNow(ctx, {
      type: "dm.intervened",
      ts: Date.now(),
      payload: { kind: "recall", participantId },
    });
    apply(ctx, { kind: "recall", participantId });
    return { ok: true };
  }

  const intervention: Intervention = { id: nid("dm"), ts: Date.now(), ...input };
  emitNow(ctx, {
    type: "dm.intervened",
    ts: intervention.ts,
    teamId: intervention.teamId,
    payload: { ...intervention },
  });
  ctx.queue.push(intervention);

  if (input.kind === "resume") {
    setTimeout(() => {
      ctx.state = { ...ctx.state, paused: false };
      for (const wake of ctx.pauseWaiters.splice(0)) wake();
    }, 0);
  }
  // Mirror pause/resume onto the state right away: a crash in this window must not
  // silently un-pause the match on recovery.
  if (input.kind === "pause" || input.kind === "resume") {
    ctx.state = { ...ctx.state, paused: input.kind === "pause" };
    persistCheckpoint(ctx);
  }
  return { ok: true };
}

export function abortMatch(matchId: string, reason = "manual"): { ok: boolean } {
  if (abortWerewolfMatch(matchId, reason)) return { ok: true };
  if (abortCoupMatch(matchId, reason)) return { ok: true };
  const ctx = contexts.get(matchId);
  if (!ctx) {
    setMatchStatus(matchId, "aborted", { endReason: reason });
    return { ok: true };
  }
  apply(ctx, { kind: "abort", reason });
  return { ok: true };
}

/* ── prompt overrides ──────────────────────────────────────────────── */

/**
 * Read per model call rather than per match: an edited template must bite on
 * the next round, not after a restart. One local SELECT against SQLite.
 */
function promptOverrides(): PromptOverrides {
  const overrides: PromptOverrides = {};
  for (const row of listPromptOverrides()) {
    if (isPromptKey(row.key)) overrides[row.key] = row.body;
  }
  return overrides;
}

/* ── one participant turn ──────────────────────────────────────────── */

async function runParticipant(ctx: Ctx, participantId: string): Promise<void> {
  const participant = ctx.state.participants.find((p) => p.id === participantId);
  if (!participant) return;
  if (participant.status === "forfeit") return;

  const started = Date.now();
  const round = ctx.state.round;
  const apiKey = getSecret(participant.model.providerId);
  const base: Submission = {
    participantId,
    seat: participant.seat,
    status: "ready",
    thinking: "",
    content: {},
    raw: "",
    usage: { promptTokens: 0, completionTokens: 0 },
    latencyMs: 0,
    anomalies: [],
  };

  const submit = (submission: Submission) => {
    saveSubmission(ctx.id, round, participant.teamId, {
      participantId,
      status: submission.status,
      thinking: submission.thinking,
      content: submission.content,
      usage: submission.usage,
      latencyMs: submission.latencyMs,
    });
    apply(ctx, { kind: "submit", submission });
  };

  if (!apiKey && participant.model.kind !== "mock") {
    submit({ ...base, status: "forfeit", anomalies: ["missing_api_key"], latencyMs: Date.now() - started });
    return;
  }

  const prompt = buildParticipantPrompt({
    blueprint: ctx.state.blueprint,
    state: ctx.state,
    participant,
    interventions: ctx.said,
    templates: promptOverrides(),
  });

  const parser = new SubmissionStreamParser();
  // Cadence, not block size: the audience gets a delta every FLUSH_MS for as long as
  // the model keeps writing, whether it writes 3 characters or 30 000.
  const pump = openDeltaPump((delta, meta) => {
    emitNow(ctx, {
      type: "seat.thinking.delta",
      seat: participant.seat,
      teamId: participant.teamId,
      ts: Date.now(),
      payload: { round, participantId, delta, coarse: meta.backedOff },
    });
  });

  let result;
  // Both bounds live on the call window: a total ceiling that only exists to cap
  // billing, and a silence detector that is the real "this call is dead" signal.
  const timeoutMs = callTimeoutFor(participant.model);
  let callWindow = openCallWindow({ timeoutMs, stallMs: STALL_MS });
  let thinkingChars = 0;
  let nativeDump = "";
  /** Content received by the *current* attempt. A retry is only free when this is 0. */
  let attemptChars = 0;

  // Rolling shingle counter: catches loops without punishing length.
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
    // Every chunk is evidence the model is still working; the stall timer resets here.
    callWindow.touch();
    if (delta.thinking) {
      thinkingChars += delta.thinking.length;
      attemptChars += delta.thinking.length;
      nativeDump += delta.thinking;
      pump.push(delta.thinking);
      if (isLooping(delta.thinking)) callWindow.abort("loop");
    }
    if (delta.text) {
      const out = parser.push(delta.text);
      if (out) {
        thinkingChars += out.length;
        attemptChars += out.length;
        pump.push(out);
        if (isLooping(out)) callWindow.abort("loop");
      }
    }
    if (MAX_THINKING_CHARS > 0 && thinkingChars > MAX_THINKING_CHARS) callWindow.abort("size");
  };

  // A silence cut that produced literally nothing may be a dead gateway rather
  // than a dead model: re-open once, on a fresh clock and a fresh AbortSignal.
  let lastCut: CallCutInfo | null = null;
  let stallRetries = 0;
  try {
    for (;;) {
      const window = callWindow;
      attemptChars = 0;
      try {
        result = await callWithRetry(
          {
            model: participant.model,
            apiKey,
            system: prompt.system,
            messages: prompt.messages,
            signal: window.signal,
            // Bytes on the wire prove the connection is alive even when the model
            // is still thinking and nothing printable has arrived yet.
            onBeat: () => window.touch(),
          },
          sink,
          // A transient 429 must not spend the model's thinking budget: new attempt, new clock.
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
            round,
            participantId,
            code: "stall_retried",
            message: `${Math.round(STALL_MS / 1000)} 秒没有收到任何内容，已重开一次`,
          },
        });
        callWindow = openCallWindow({ timeoutMs, stallMs: STALL_MS });
      }
    }
  } catch (err) {
    callWindow.close();
    pump.stop();
    const elapsed = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    submit({
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
  pump.stop();

  let fin = parser.finish();
  // Some gateways stream everything through the reasoning channel and leave the
  // visible answer empty. Re-parse that channel before declaring a forfeit.
  if (!fin.content && nativeDump.trim()) {
    const salvage = new SubmissionStreamParser();
    salvage.push(nativeDump);
    const retried = salvage.finish();
    if (retried.content) fin = retried;
  }
  // The curated <<<THINK>>> block leads: that is the note written for the audience.
  const thinking = [fin.thinking, result.thinking.trim()].filter(Boolean).join("\n\n").trim();

  if (!fin.content) {
    submit({
      ...base,
      status: "forfeit",
      thinking,
      anomalies: fin.anomalies.length ? fin.anomalies : ["no_submission"],
      usage: result.usage,
      latencyMs: result.latencyMs,
      raw: result.text,
    });
    return;
  }

  const checked = validateSubmission(ctx.state.blueprint, fin.content);
  if (!checked.ok) {
    // One clean retry at temperature 0 before giving the round away.
    try {
      const retry = await callWithRetry(
        {
          model: { ...participant.model, temperature: 0 },
          apiKey,
          system: prompt.system,
          messages: [
            ...prompt.messages,
            { role: "assistant" as const, content: result.text },
            {
              role: "user" as const,
              content: `你上一次的提交有问题：\n${checked.errors.join("\n")}\n只输出修正后的 JSON，不要思考、不要解释。`,
            },
          ],
          // The repair turn gets the same ceiling as the original call; never unbounded.
          ...(Number.isFinite(timeoutMs) ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        },
        () => {},
      );
      const repaired = repairJson(retry.text);
      const retryChecked = validateSubmission(ctx.state.blueprint, JSON.parse(repaired));
      if (retryChecked.ok) {
        submit({
          ...base,
          thinking,
          content: retryChecked.content,
          usage: addUsage(result.usage, retry.usage),
          latencyMs: Date.now() - started,
          raw: retry.text,
          anomalies: fin.anomalies,
        });
        return;
      }
    } catch {
      /* fall through to forfeit */
    }
    submit({
      ...base,
      status: "forfeit",
      thinking,
      anomalies: [...fin.anomalies, ...checked.errors.map((e) => `invalid_submission: ${e}`)],
      usage: result.usage,
      latencyMs: Date.now() - started,
      raw: result.text,
    });
    return;
  }

  submit({
    ...base,
    thinking,
    content: checked.content,
    usage: result.usage,
    latencyMs: result.latencyMs,
    raw: result.text,
    anomalies: fin.anomalies,
  });
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedPromptTokens: (a.cachedPromptTokens ?? 0) + (b.cachedPromptTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

/* ── judging ───────────────────────────────────────────────────────── */

/** Declared meters only, values untouched: used to compare the judge's copy with the ledger. */
function rawMeterState(board: BoardSpec | undefined, raw: unknown): Record<string, number> {
  if (!board || !raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const meter of board.meters) {
    const value = Number(source[meter.key]);
    if (Number.isFinite(value)) out[meter.key] = value;
  }
  return out;
}

async function runJudge(
  ctx: Ctx,
  round: number,
  sudden: boolean,
  settlement: Settlement | null,
): Promise<JudgeVerdict | null> {
  const judgeModel = ctx.state.judgeModel;
  if (!judgeModel) return null;
  const apiKey = getSecret(judgeModel.providerId);
  if (!apiKey && judgeModel.kind !== "mock") return null;

  const blindMap = blindMapFor(ctx.state.seed, round, ctx.state.teams.map((t) => t.id));
  if (!ctx.warnedJudge) {
    ctx.warnedJudge = true;
    const clash = ctx.state.participants.filter((p) => p.model.providerId === judgeModel.providerId);
    if (clash.length > 0) {
      emitNow(ctx, {
        type: "anomaly",
        ts: Date.now(),
        payload: {
          code: "judge_not_independent",
          message: `裁判与 ${clash.length} 位选手同属一个厂商，判分可能带自偏好`,
        },
      });
    }
  }

  const prompt = buildJudgePrompt({
    blueprint: ctx.state.blueprint,
    state: ctx.state,
    blindMap,
    sudden,
    settlement,
    templates: promptOverrides(),
  });
  let full = "";
  // The referee's reasoning is a live stream too: same cadence contract as the seats.
  const pump = openDeltaPump((delta) => {
    emitNow(ctx, { type: "judge.thinking.delta", ts: Date.now(), payload: { round, delta } });
  });
  const judgeTimeoutMs = callTimeoutFor(judgeModel);
  // An AbortError reads the same whichever bound fired, so remember which one did.
  let lastCut: CallCutInfo | null = null;

  const callJudge = async (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    temperature?: number,
  ) => {
    let stallRetries = 0;
    for (;;) {
      // A fresh window per attempt: a spent ceiling must not kill the retry, and a
      // referee that keeps talking is never cut for being slow.
      const callWindow = openCallWindow({ timeoutMs: judgeTimeoutMs, stallMs: STALL_MS });
      /** Content received by this attempt; a silence retry is only free when 0. */
      let attemptChars = 0;
      try {
        return await callWithRetry(
          {
            model: temperature === undefined ? judgeModel : { ...judgeModel, temperature },
            apiKey,
            system: prompt.system,
            messages,
            signal: callWindow.signal,
            json: true,
            onBeat: () => callWindow.touch(),
          },
          (delta) => {
            callWindow.touch();
            if (delta.thinking) {
              attemptChars += delta.thinking.length;
              pump.push(delta.thinking);
              full += delta.thinking;
            }
            if (delta.text) {
              attemptChars += delta.text.length;
              pump.push(delta.text);
              full += delta.text;
            }
          },
          () => callWindow.rearm(),
        );
      } catch (err) {
        const cut = callWindow.cut();
        if (cut) {
          lastCut = {
            cut,
            elapsedMs: callWindow.elapsedMs(),
            idleMs: callWindow.idleMs(),
            timeoutMs: judgeTimeoutMs,
          };
        }
        if (shouldRetryStall({ cut, receivedChars: attemptChars, retriesUsed: stallRetries })) {
          stallRetries += 1;
          emitNow(ctx, {
            type: "anomaly",
            ts: Date.now(),
            payload: {
              round,
              code: "stall_retried",
              message: `裁判 ${Math.round(STALL_MS / 1000)} 秒没有收到任何内容，已重开一次`,
            },
          });
          continue;
        }
        throw err;
      } finally {
        callWindow.close();
      }
    }
  };

  try {
    let result = await callJudge(prompt.messages);
    // Ship the tail before parsing: the audience should see the reasoning that
    // produced the verdict, not a truncated feed.
    pump.drain();

    const tryParse = (text: string) => JSON.parse(repairJson(text)) as {
      scores?: Record<string, Record<string, number | string>>;
      state?: Record<string, Record<string, number | string>>;
      marks?: unknown;
      winner?: string;
      verdict?: string;
      publicSummary?: string;
    };

    let parsed: ReturnType<typeof tryParse>;
    try {
      parsed = tryParse(result.text?.trim() ? result.text : full);
    } catch (err) {
      // One strict repair turn: show the model what it produced and demand JSON only.
      emitNow(ctx, {
        type: "anomaly",
        ts: Date.now(),
        payload: {
          round,
          code: "judge_retry",
          message: err instanceof Error ? err.message.slice(0, 120) : "parse failed",
        },
      });
      const repair = await callJudge(
        [
          ...prompt.messages,
          { role: "assistant" as const, content: (result.text || full).slice(0, 4000) },
          {
            role: "user" as const,
            content: "上一条不是合法 JSON。" + (sudden
              ? '只输出 {"winner":"A","verdict":"…","publicSummary":"…"}，不要任何解释。'
              : '只输出 {"scores":{…},"verdict":"…","publicSummary":"…"}，不要任何解释。'),
          },
        ],
        0,
      );
      pump.drain();
      result = repair;
      parsed = tryParse(repair.text?.trim() ? repair.text : full);
    }

    const letters = teamLetters(ctx.state.teams.length);
    const board = ctx.state.blueprint.board;
    const boardIssues: Array<{ code: string; detail?: string }> = [];
    const judgeScores: TeamScoreLine[] = [];
    if (!sudden) {
      for (const letter of letters) {
        const teamId = blindMap[letter];
        const raw = parsed.scores?.[letter] ?? {};
        const dims: Record<string, number> = {};
        let weighted = 0;
        for (const dim of ctx.state.blueprint.rubric.dimensions) {
          const value = Number(raw[dim.key] ?? 0);
          dims[dim.key] = Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : 0;
          weighted += dims[dim.key] * dim.weight;
        }
        // A ledger board's numbers are the engine's; keep the judge's raw copy only
        // to compare against, so clamping it first would manufacture a false conflict.
        const read = settlement
          ? { state: rawMeterState(board, parsed.state?.[letter]), issues: [] as Array<{ code: string; detail?: string }> }
          : parseBoardState(board, parsed.state?.[letter]);
        boardIssues.push(...read.issues);
        judgeScores.push({
          teamId,
          dimensions: dims,
          weighted: Number(weighted.toFixed(3)),
          notes: typeof raw.notes === "string" ? raw.notes : "",
          ...(Object.keys(read.state).length ? { state: read.state } : {}),
        });
      }
    }

    // The ledger outranks the judge on everything mechanical: absolute readings and
    // any dimension the ruleset derived. What the judge wrote stays in `notes`.
    const merged = applySettlement({
      settlement,
      board,
      dimensions: ctx.state.blueprint.rubric.dimensions,
      scores: judgeScores,
    });
    const scores = merged.scores;
    if (merged.corrections.length > 0) {
      emitNow(ctx, {
        type: "anomaly",
        ts: Date.now(),
        payload: {
          round,
          code: "board_mismatch",
          message: merged.corrections
            .slice(0, 6)
            .map((c) => `${c.teamId}.${c.field}: judge ${c.judge ?? "—"} → ledger ${c.engine}`)
            .join("; "),
        },
      });
    }
    const outside = outOfRange(board, settlement);
    if (outside.length > 0) {
      emitNow(ctx, {
        type: "anomaly",
        ts: Date.now(),
        payload: {
          round,
          code: "board_out_of_range",
          message: outside.map((o) => `${o.meter} ${o.value} 越界 ${o.limit}`).join("; "),
        },
      });
    }

    const parsedMarks = sudden ? { marks: [], issues: [] } : parseMarks(board, parsed.marks);
    boardIssues.push(...parsedMarks.issues);
    if (boardIssues.length > 0) {
      const byCode = new Map<string, string[]>();
      for (const issue of boardIssues) {
        const list = byCode.get(issue.code) ?? [];
        if (issue.detail) list.push(issue.detail);
        byCode.set(issue.code, list);
      }
      for (const [code, details] of byCode) {
        emitNow(ctx, {
          type: "anomaly",
          ts: Date.now(),
          payload: {
            round,
            code,
            message: details.length ? `board: ${details.slice(0, 6).join(", ")}` : "board",
          },
        });
      }
    }

    const verdict: JudgeVerdict = {
      round,
      blindMap,
      scores,
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : "",
      // A settled round publishes the engine's ledger line: it is keyed by team name,
      // so the audience never has to translate this round's letters.
      publicSummary: settlement
        ? settlement.summary
        : typeof parsed.publicSummary === "string"
          ? parsed.publicSummary
          : parsed.verdict ?? "",
      judgeModel,
      usage: result.usage,
      ...(board?.marks ? { marks: parsedMarks.marks } : {}),
      settlement,
      suddenWinnerTeamId: sudden
        ? (() => {
            const letter = (parsed.winner ?? "").trim().toUpperCase();
            if (blindMap[letter]) return blindMap[letter];
            const first = Object.keys(blindMap).sort()[0];
            return first ? blindMap[first] : null;
          })()
        : null,
    };

    saveJudgement({
      matchId: ctx.id,
      round,
      sudden,
      judge: judgeModel,
      blindMap,
      scores: verdict.scores,
      verdict: verdict.verdict,
      usage: result.usage,
    });

    return verdict;
  } catch (err) {
    emitNow(ctx, {
      type: "anomaly",
      ts: Date.now(),
      payload: {
        round,
        code: "judge_failed",
        message: failureMessage(lastCut, err),
      },
    });
    return null;
  } finally {
    pump.stop();
  }
}

/* ── crash recovery ────────────────────────────────────────────────── */

/** Is a live loop driving this match right now, in either genre? */
export function isLive(matchId: string): boolean {
  if (werewolfLive(matchId)) return true;
  if (coupLive(matchId)) return true;
  const ctx = contexts.get(matchId);
  return !!ctx && !ctx.stop;
}

/**
 * Rebuild a match from its checkpoint and re-issue only what it still owes.
 * Never called automatically: resuming spends real model calls, so the operator
 * asks for it.
 */
export function recoverMatch(matchId: string): RecoverResult {
  const match = getMatch(matchId);
  if (!match) return { ok: false, code: "not_found", error: "对局不存在" };
  if (match.status === "finished" || match.status === "aborted" || match.status === "failed") {
    return { ok: false, code: "finished", error: "对局已结束" };
  }
  if (match.kind === "werewolf") return recoverWerewolfMatch(matchId);
  if (match.kind === "coup") return recoverCoupMatch(matchId);
  return recoverRubricMatch(matchId);
}

function recoverRubricMatch(matchId: string): RecoverResult {
  const live = contexts.get(matchId);
  if (live && !live.stop) return { ok: true, already: true };
  if (live?.stop) return { ok: false, code: "finished", error: "对局已结束" };
  if (recovering.has(matchId)) return { ok: false, code: "busy", error: "恢复正在进行中" };

  recovering.add(matchId);
  try {
    const checkpoint = loadCheckpoint(matchId);
    if (!checkpoint || checkpoint.kind !== "rubric") {
      return { ok: false, code: "no_checkpoint", error: "这一局没有断点，无法续跑" };
    }
    const payload = checkpoint.payload as Partial<RubricCheckpoint> | null;
    const state = payload?.state;
    if (!state || state.matchId !== matchId || !Array.isArray(state.participants)) {
      return { ok: false, code: "corrupt", error: "断点已损坏，无法续跑" };
    }

    // The checkpoint can already be terminal if the process died between the final
    // verdict and the status write. Settle it instead of resurrecting the match.
    if (state.phase === "done") {
      setMatchStatus(matchId, "finished", {
        winnerTeamId: state.winnerTeamId,
        endReason: state.endReason ?? "recovered_done",
      });
      updateMatchUsage(matchId, state.budget.calls, state.budget.tokens, state.budget.cachedTokens ?? 0);
      updateTeamTotals(matchId, state.teams);
      dropCheckpoint(matchId);
      return { ok: false, code: "finished", error: "对局已结束" };
    }
    if (state.phase === "idle") {
      return { ok: false, code: "corrupt", error: "断点停在开局前，无法续跑" };
    }

    const { state: next, effects } = recoverRound(state);
    const ctx: Ctx = {
      id: matchId,
      state: next,
      seq: nextSeq(matchId),
      stop: false,
      pauseWaiters: [],
      queue: [],
      said: payload?.said ?? [],
      warnedJudge: payload?.warnedJudge === true,
      checkpointBroken: false,
    };
    contexts.set(matchId, ctx);
    setMatchStatus(matchId, "running");
    updateMatchUsage(matchId, next.budget.calls, next.budget.tokens, next.budget.cachedTokens ?? 0);

    const owed = effects.flatMap((effect) =>
      effect.kind === "call_participants" ? effect.ids : [],
    );
    const gapMs = Math.max(0, Date.now() - (lastEventTs(matchId) ?? Date.now()));
    emitNow(ctx, {
      type: "match.recovered",
      ts: Date.now(),
      payload: { kind: "rubric", round: next.round, phase: next.phase, paused: next.paused, owed, gapMs },
    });
    persistCheckpoint(ctx);
    for (const effect of effects) dispatch(ctx, effect);

    return { ok: true, resumed: true, day: next.round, phase: next.phase, owed };
  } catch (err) {
    return { ok: false, code: "corrupt", error: err instanceof Error ? err.message : String(err) };
  } finally {
    recovering.delete(matchId);
  }
}

/* ── boot ──────────────────────────────────────────────────────────── */

/**
 * Seed, migrate and sweep orphan rows. Parked on globalThis because Next gives each
 * route its own module graph: two routes must share one boot, not run two sweeps.
 */
function bootRuntime(): Promise<void> {
  if (G.__arenaBoot) return G.__arenaBoot;
  G.__arenaBoot = import("@/db/repo").then((m) => {
    try {
      m.ensureSeedData();
      // Never bury a match that is already being resumed.
      m.markOrphansInterrupted((id) => isLive(id));
      void import("@/lib/rulesets").then((r) => r.syncBuiltinRulesets()).catch(() => {});
    } catch {
      /* routes will surface db problems */
    }
  });
  return G.__arenaBoot;
}

export function ensureRuntime(): void {
  if (G.__arenaBooted) return;
  G.__arenaBooted = true;
  void bootRuntime();
}

/**
 * Recovery has to wait for the sweep: otherwise the boot's `markOrphansInterrupted`
 * can land *after* the match was restarted and write `interrupted` over `running`.
 */
export async function whenBooted(): Promise<void> {
  ensureRuntime();
  await bootRuntime();
}
