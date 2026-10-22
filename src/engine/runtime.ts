/**
 * The runtime owns everything impure: provider calls, clock, database, fan-out.
 * The engine stays pure; this file turns its effects into reality.
 */

import { nid } from "@/db/client";
import {
  appendEvent,
  createMatch,
  ensureSeedData,
  getModelRow,
  getRulesetById,
  listModels,
  listPromptOverrides,
  listProviders,
  listRulesets,
  nextSeq,
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
import { parseBlueprint, teamLetters, validateSubmission } from "./blueprint";
import { chooseJudge } from "./judge";
import { SubmissionStreamParser, repairJson } from "./parse";
import { buildJudgePrompt, buildParticipantPrompt } from "./prompt";
import { isPromptKey, type PromptOverrides } from "./prompt-templates";
import { blindMapFor, budgetExhausted, createMatchState, reduce } from "./round";
import { makeSeed, shuffle } from "./rng";
import type {
  ArenaEvent,
  Effect,
  Intervention,
  JudgeVerdict,
  MatchState,
  ModelSnapshot,
  ParticipantState,
  Submission,
  TeamScoreLine,
  TeamState,
} from "./types";

/**
 * Calls stay bounded so a runaway loop cannot bill forever; tokens do not.
 * 0 = unlimited: the arena never imposes an input/output token ceiling.
 */
const DEFAULT_BUDGET = { maxCalls: 200, maxTokens: 0 };

/**
 * A round waits for everyone, so one chatty model can stall the whole table.
 * Every call gets a hard deadline; on timeout that seat forfeits the round.
 */
const CALL_TIMEOUT_MS = Number(process.env.ARENA_CALL_TIMEOUT_MS ?? 180_000);
/**
 * Small models can degrade into an endless monologue and never emit <<<SUBMIT>>>.
 * A plain length cap would punish legitimately long reasoning, so we look for the
 * actual failure signature: the same 60-character window repeating over and over.
 */
const MAX_THINKING_CHARS = Number(process.env.ARENA_MAX_THINKING_CHARS ?? 300_000);
/**
 * Time-based cutoff beats a character cap here: reasoning models legitimately burn
 * thousands of characters before answering, but a model that has spent this long
 * without even starting the submit block is not going to arrive.
 */
const NO_SUBMIT_MS = Number(process.env.ARENA_NO_SUBMIT_MS ?? 150_000);
const REPEAT_WINDOW = 60;
const REPEAT_LIMIT = 6;
/** Streaming granularity, not a content cap: past this many chunks the audience
 *  still gets every character, just in coarser blocks (see COARSE_FLUSH_CHARS). */
const MAX_THINKING_CHUNKS = 400;
const CHUNK_FLUSH_CHARS = 64;
/** After MAX_THINKING_CHUNKS, coalesce this many characters per event instead of
 *  dropping the tail — a frozen live stream reads as "the match is stuck". */
const COARSE_FLUSH_CHARS = Number(process.env.ARENA_COARSE_FLUSH_CHARS ?? 2_048);

/**
 * Characters per streaming event. Fine-grained at first so the audience watches
 * the model think; once the chunk budget is spent, coalesce instead of going
 * silent. Never return Infinity: a tail still has to reach the screen.
 */
export function thinkingFlushThreshold(emitted: number): number {
  return emitted < MAX_THINKING_CHUNKS ? CHUNK_FLUSH_CHARS : COARSE_FLUSH_CHARS;
}

/** Why a participant turn ended without a submission. Exported for tests. */
export function forfeitReason(input: {
  runaway: boolean;
  elapsedMs: number;
  timeoutMs: number;
  message: string;
}): string {
  const seconds = Math.round(input.elapsedMs / 1000);
  if (input.runaway) return `thinking_runaway: ${seconds} 秒内没有开始提交，已截断`;
  // The deadline AbortController is the only thing that fires this late.
  if (input.elapsedMs >= input.timeoutMs - 1_000) return `call_timeout: ${seconds} 秒未返回，已中止`;
  return `actor_failed: ${input.message}`;
}

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
}

// Next.js gives each route its own module graph; park live state on globalThis.
const G = globalThis as unknown as { __arenaRuntime?: Map<string, Ctx>; __arenaBooted?: boolean };
const contexts: Map<string, Ctx> = (G.__arenaRuntime ??= new Map<string, Ctx>());

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
  seed: string;
  teams: Array<{ id: string; name: string; color: string; members: Array<{ seat: number; display: string }> }>;
  judge: string | null;
}

export async function startMatch(options: StartOptions = {}): Promise<StartResult> {
  ensureSeedData();

  const rulesets = listRulesets().filter((r) => r.enabled);
  const ruleset = options.rulesetId ? getRulesetById(options.rulesetId) : rulesets[0];
  if (!ruleset) throw new Error("没有可用的规则：先去 /rulesets 写一条，或启用内置规则");
  const blueprint = parseBlueprint(ruleset.blueprint);
  const seed = options.seed?.trim() || makeSeed();

  const keyed = keyedProviders();
  const usable = usableModels(keyed);
  const contenders = usable.filter((m) => m.inContenderPool);
  if (contenders.length < 2) {
    throw new Error("至少需要两个可用的选手模型：去 /setups 填 Key 并拉取模型，或启用本地演练体");
  }

  /* resolve roster */
  let teamSpecs: Array<{ name?: string; modelIds: string[] }>;
  if (options.teams && options.teams.length >= 2) {
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
  };
  contexts.set(matchId, ctx);

  apply(ctx, { kind: "start", at: Date.now() });

  return {
    matchId,
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

  for (const effect of effects) dispatch(ctx, effect);
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
        const verdict = await runJudge(ctx, effect.round, effect.sudden);
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
  updateMatchUsage(ctx.id, ctx.state.budget.calls, ctx.state.budget.tokens);
  updateTeamTotals(ctx.id, ctx.state.teams);
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
    delta?: number;
  },
): { ok: boolean; error?: string } {
  const ctx = contexts.get(matchId);
  if (!ctx) return { ok: false, error: "对局不在运行中" };
  if (ctx.stop) return { ok: false, error: "对局已结束" };

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
  return { ok: true };
}

export function abortMatch(matchId: string, reason = "manual"): { ok: boolean } {
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
  let buffer = "";
  let emitted = 0;
  const flush = (force = false) => {
    if (!buffer) return;
    const threshold = thinkingFlushThreshold(emitted);
    if (!force && buffer.length < threshold) return;
    const delta = buffer;
    buffer = "";
    emitted += 1;
    emitNow(ctx, {
      type: "seat.thinking.delta",
      seat: participant.seat,
      teamId: participant.teamId,
      ts: Date.now(),
      payload: { round, participantId, delta, coarse: emitted >= MAX_THINKING_CHUNKS },
    });
  };

  let result;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let runaway = false;
  let thinkingChars = 0;
  let nativeDump = "";

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
    if (delta.thinking) {
      thinkingChars += delta.thinking.length;
      nativeDump += delta.thinking;
      buffer += delta.thinking;
      flush();
      if (isLooping(delta.thinking)) runaway = true;
    }
    if (delta.text) {
      const out = parser.push(delta.text);
      if (out) {
        thinkingChars += out.length;
        buffer += out;
        flush();
        if (isLooping(out)) runaway = true;
      }
    }
    if (!runaway && thinkingChars > MAX_THINKING_CHARS) runaway = true;
    if (!runaway && !parser.sawSubmit && Date.now() - started > NO_SUBMIT_MS) runaway = true;
    if (runaway) controller.abort();
  };

  // A silent gateway stops calling the sink entirely, so the delta-driven check
  // above can never fire. Poll the same deadline on a timer: a stalled stream is
  // cut at NO_SUBMIT_MS, not left hanging until the hard timeout.
  const watchdog = setInterval(() => {
    if (runaway) return;
    if (!parser.sawSubmit && Date.now() - started > NO_SUBMIT_MS) {
      runaway = true;
      controller.abort();
    }
  }, 1_000);

  try {
    result = await callWithRetry(
      {
        model: participant.model,
        apiKey,
        system: prompt.system,
        messages: prompt.messages,
        signal: controller.signal,
      },
      sink,
    );
  } catch (err) {
    clearTimeout(deadline);
    clearInterval(watchdog);
    flush(true);
    const elapsed = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    submit({
      ...base,
      status: "forfeit",
      anomalies: [forfeitReason({ runaway, elapsedMs: elapsed, timeoutMs: CALL_TIMEOUT_MS, message })],
      latencyMs: elapsed,
    });
    return;
  }
  clearTimeout(deadline);
  clearInterval(watchdog);
  flush(true);

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

function addUsage(
  a: { promptTokens: number; completionTokens: number },
  b: { promptTokens: number; completionTokens: number },
) {
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens };
}

/* ── judging ───────────────────────────────────────────────────────── */

async function runJudge(ctx: Ctx, round: number, sudden: boolean): Promise<JudgeVerdict | null> {
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
    templates: promptOverrides(),
  });
  let buffer = "";
  let full = "";

  try {
    const callJudge = (messages: Array<{ role: "user" | "assistant"; content: string }>, temperature?: number) =>
      callWithRetry(
        {
          model: temperature === undefined ? judgeModel : { ...judgeModel, temperature },
          apiKey,
          system: prompt.system,
          messages,
          // A fresh deadline per attempt; a spent one must not kill the retry.
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          json: true,
        },
        (delta) => {
          if (delta.thinking) {
            buffer += delta.thinking;
            full += delta.thinking;
          }
          if (delta.text) {
            buffer += delta.text;
            full += delta.text;
          }
          if (buffer.length >= 60) {
            const chunk = buffer;
            buffer = "";
            emitNow(ctx, {
              type: "judge.thinking.delta",
              ts: Date.now(),
              payload: { round, delta: chunk },
            });
          }
        },
      );

    let result = await callJudge(prompt.messages);
    if (buffer) {
      emitNow(ctx, { type: "judge.thinking.delta", ts: Date.now(), payload: { round, delta: buffer } });
      buffer = "";
    }

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
      if (buffer) {
        emitNow(ctx, { type: "judge.thinking.delta", ts: Date.now(), payload: { round, delta: buffer } });
        buffer = "";
      }
      result = repair;
      parsed = tryParse(repair.text?.trim() ? repair.text : full);
    }

    const letters = teamLetters(ctx.state.teams.length);
    const board = ctx.state.blueprint.board;
    const boardIssues: Array<{ code: string; detail?: string }> = [];
    const scores: TeamScoreLine[] = [];
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
        const read = parseBoardState(board, parsed.state?.[letter]);
        boardIssues.push(...read.issues);
        scores.push({
          teamId,
          dimensions: dims,
          weighted: Number(weighted.toFixed(3)),
          notes: typeof raw.notes === "string" ? raw.notes : "",
          ...(Object.keys(read.state).length ? { state: read.state } : {}),
        });
      }
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
      publicSummary: typeof parsed.publicSummary === "string" ? parsed.publicSummary : parsed.verdict ?? "",
      judgeModel,
      usage: result.usage,
      ...(board?.marks ? { marks: parsedMarks.marks } : {}),
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
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

/* ── boot ──────────────────────────────────────────────────────────── */

export function ensureRuntime(): void {
  if (G.__arenaBooted) return;
  G.__arenaBooted = true;
  void import("@/db/repo").then((m) => {
    try {
      m.ensureSeedData();
      m.markOrphansInterrupted();
      void import("@/lib/rulesets").then((r) => r.syncBuiltinRulesets()).catch(() => {});
    } catch {
      /* routes will surface db problems */
    }
  });
}
