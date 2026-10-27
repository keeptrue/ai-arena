/** Core domain types for the rule-driven arena. Nothing here performs I/O. */

import type { WerewolfBlueprint } from "./werewolf/types";
import type { CoupBlueprint } from "./coup/types";

export type ProviderKind = "openai" | "anthropic" | "gemini" | "mock";

/** How hard a reasoning model should think. Mirrors models.dev's effort vocabulary. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Which knob the provider actually accepts for reasoning:
 * effort (`reasoning_effort`), a token budget (`thinking.budget_tokens`), or a plain on/off toggle.
 */
export type ReasoningStyle = "effort" | "budget_tokens" | "toggle";

/** One reasoning knob as advertised by models.dev. */
export type ReasoningOption =
  | { type: "effort"; values: ReasoningEffort[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min?: number; max?: number };

/** A models.dev model card, cached next to the row so the UI can offer real choices. */
export interface ModelCard {
  source: "models.dev";
  /** `${providerKey}/${modelId}` inside the models.dev catalogue. */
  key: string;
  name: string;
  contextWindow: number | null;
  outputLimit: number | null;
  cost: { input: number | null; output: number | null } | null;
  /** Some reasoning models reject any non-default temperature outright. */
  supportsTemperature?: boolean;
  reasoning: boolean;
  options: ReasoningOption[];
  fetchedAt: number;
}

export interface ModelSnapshot {
  providerId: string;
  providerName: string;
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
  display: string;
  temperature: number;
  supportsReasoning: boolean;
  /** Reasoning strength to request; null/absent = whatever the provider defaults to. */
  reasoningEffort?: ReasoningEffort | null;
  /** Explicit thinking budget in tokens (anthropic / gemini). Overrides the effort mapping. */
  thinkingBudget?: number | null;
  /** Which reasoning knob this model speaks. Derived from its models.dev card. */
  reasoningStyle?: ReasoningStyle | null;
  /** false = do not send a temperature at all (models.dev says the model ignores it). */
  supportsTemperature?: boolean;
  /** Per-model call ceiling in ms. Null/absent = inherit ARENA_CALL_TIMEOUT_MS. */
  callTimeoutMs?: number | null;
  /**
   * How this endpoint's prompt cache works. `auto` = the provider matches prefixes
   * on its own (DeepSeek, Gemini, OpenAI); `explicit` = we must mark breakpoints
   * (Anthropic, OpenRouter passthrough); `none` = do not bother. Null/absent = infer
   * from `kind`.
   */
  providerCacheMode?: ProviderCacheMode | null;
}

export type ProviderCacheMode = "auto" | "explicit" | "none";

/**
 * What one model call cost, in tokens.
 *
 * `promptTokens` is the total input read; `cachedPromptTokens` is the slice a prefix
 * cache served, so it is always ≤ `promptTokens`. The engine never caps on tokens
 * (AGENTS §5) — this is accounting, not a budget.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Call accounting for one match. `tokens` is the raw sum (never a cap — AGENTS §5);
 * `cachedTokens` is the slice of it that a prefix cache served, carried separately so
 * the audience can see the hit rate without rewriting history.
 */
export interface CallBudget {
  maxCalls: number;
  maxTokens: number;
  calls: number;
  tokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}


/* ── blueprint: the compiled form of a natural-language rule set ────── */

export interface BlueprintSlot {
  key: string;
  label: string;
  type: "text" | "number" | "choice";
  choices?: string[];
  required: boolean;
  /** public → goes into next round's shared record; secret → judge only. */
  reveal: "public" | "secret";
  hint?: string;
}

/**
 * Optional deterministic formula for a dimension: `base + per × (meter's round
 * delta)`, clamped. The engine computes it instead of asking the judge to do
 * arithmetic; declaring it requires the board to carry a `settle` ledger.
 */
export interface RubricDerive {
  meter: string;
  base: number;
  per?: number;
  min?: number;
  max?: number;
}

export interface RubricDimension {
  key: string;
  label: string;
  weight: number;
  hint: string;
  derive?: RubricDerive;
}

/** How a declared number is drawn. `track` is the 0..max lane (山道); at most one per board. */
export type BoardMeterKind = "bar" | "count" | "track";
export type BoardTone = "jade" | "amber" | "blood" | "ghost";

/**
 * One number the rules keep (blood, ladder step, cards left). The engine never
 * interprets it: it only clamps to [min, max] and hands it to the UI.
 */
export interface BoardMeter {
  key: string;
  label: string;
  kind: BoardMeterKind;
  min: number;
  max: number;
  /** Shown before the first verdict arrives. */
  init: number;
  /** Draw a line here (e.g. the release bar) and turn the fill red below it. */
  threshold?: number;
  tone?: BoardTone;
}

export interface BoardSettlementCell {
  /** Lower-`idx` team's move. */
  a: string;
  /** Higher-`idx` team's move. */
  b: string;
  /** `[lower, higher]` deltas, keyed by meter. Missing meter = unchanged. */
  delta: [Record<string, number>, Record<string, number>];
}

/**
 * Deterministic per-round ledger the ruleset declares as data: given both sides'
 * moves, apply these meter deltas. The engine never learns what a move *means* —
 * it looks up the exact string a `choice` slot returned.
 */
export interface BoardSettlement {
  /** Slot key both sides submit; must be a `choice` slot. */
  by: string;
  /** Value a forfeited / absent seat stands in as. */
  forfeit: string;
  /** Must cover every combination of that slot's choices, exactly once. */
  cells: BoardSettlementCell[];
}

export interface BoardSpec {
  meters: BoardMeter[];
  /** Declares that the board has disposable marks (mines): judge returns `marks: number[]`. */
  marks?: { label: string };
  /** Present = this board is settled by the engine, not written by the judge. */
  settle?: BoardSettlement;
}

export interface Blueprint {
  /** Absent means the original rubric format. */
  mode?: "rubric";
  id: string;
  name: string;
  tagline: string;
  rounds: number;
  /** Optional live scoreboard the UI can draw. Absent = no board, exactly like before. */
  board?: BoardSpec;
  /** Rule text, injected verbatim into both participant and judge prompts. */
  briefing: string;
  submission: { slots: BlueprintSlot[] };
  rubric: { dimensions: RubricDimension[] };
  victory: {
    type: "rubric_total";
    tiebreaker: "sudden_death";
    tieThreshold: number;
  };
  judgeBrief?: string;
}

export interface Ruleset {
  id: string;
  slug: string;
  name: string;
  sourceMd: string;
  blueprint: AnyBlueprint;
  blueprintHash: string;
  compiledAt: number | null;
  compiledBy: string | null;
  enabled: boolean;
}

/** Two genres share the app: rubric duels and the nine-seat werewolf table. */
export type GameKind = "rubric" | "werewolf" | "coup";
export type AnyBlueprint = Blueprint | WerewolfBlueprint | CoupBlueprint;

/* ── roster ─────────────────────────────────────────────────────────── */

export interface ParticipantState {
  id: string;
  seat: number;
  teamId: string;
  model: ModelSnapshot;
  status: "idle" | "thinking" | "ready" | "forfeit";
  forfeits: number;
}

export interface TeamState {
  id: string;
  name: string;
  color: string;
  idx: number;
  memberIds: string[];
  roundScore: number;
  totalScore: number;
  forfeits: number;
}

/* ── submissions & verdicts ────────────────────────────────────────── */

export interface Submission {
  participantId: string;
  seat: number;
  status: "ready" | "forfeit";
  thinking: string;
  content: Record<string, unknown>;
  raw: string;
  usage: TokenUsage;
  latencyMs: number;
  anomalies: string[];
}

export interface TeamScoreLine {
  teamId: string;
  dimensions: Record<string, number>;
  /** Weighted rubric score, 0–10. */
  weighted: number;
  notes: string;
  /** Absolute board read-out after this round, keyed by BoardMeter.key. Opaque to the engine. */
  state?: Record<string, number>;
}

/** One side's line in a settled round: what it played, what it cost, where it stands. */
export interface SettlementSide {
  teamId: string;
  /** The declared `by` value this side submitted; null when it forfeited. */
  move: string | null;
  /** The seat forfeited or never submitted, so the ruleset's stand-in value stood in. */
  substituted?: boolean;
  /** Meter key → delta applied this round (non-zero keys only). */
  delta: Record<string, number>;
  /** Meter key → absolute value after this round. Not clamped: truth is truth. */
  state: Record<string, number>;
}

/**
 * A round the engine settled itself. Pure output of the ruleset's `settle` table,
 * keyed by team id from the start — no blind letters, so a rotating A/B map can
 * never reassign a number to the wrong side.
 */
export interface Settlement {
  round: number;
  /** Slot key used for the lookup. */
  by: string;
  /** Value a forfeited seat stood in as, so renderers can spell out "弃权记合作". */
  forfeit: string;
  sides: SettlementSide[];
  /** A seat forfeited and the declared stand-in value was used. */
  substituted: boolean;
  /** Team-named ledger line, e.g. `血量：赤 13 / 青 17（…）｜本轮 … → …`. */
  summary: string;
}

export interface JudgeVerdict {
  round: number;
  /** "A" | "B" | … → teamId. Re-drawn every round. */
  blindMap: Record<string, string>;
  scores: TeamScoreLine[];
  verdict: string;
  publicSummary: string;
  judgeModel: ModelSnapshot;
  usage: TokenUsage;
  /** Set only on a sudden-death round: the judge names a winner outright. */
  suddenWinnerTeamId?: string | null;
  /** Squares currently occupied by a disposable mark (mines), when the board declares `marks`. */
  marks?: number[];
  /** Engine-settled ledger for this round, when the ruleset declares one. */
  settlement?: Settlement | null;
}

export interface RoundRecord {
  round: number;
  sudden: boolean;
  closedAt: number;
  submissions: Array<{
    participantId: string;
    seat: number;
    teamId: string;
    status: "ready" | "forfeit";
    thinking: string;
    content: Record<string, unknown>;
  }>;
  verdict: JudgeVerdict | null;
  teamScores: Record<string, number>;
  /** Engine-settled board for this round; present only for ledger boards. */
  settlement?: Settlement | null;
}

/* ── interventions ─────────────────────────────────────────────────── */

export type InterventionKind = "pause" | "resume" | "say" | "rule" | "score" | "forfeit" | "recall";

export interface Intervention {
  id: string;
  kind: InterventionKind;
  text?: string;
  teamId?: string;
  participantId?: string;
  /** Nine-seat table only: the seat a `recall` re-opens. */
  seat?: number;
  delta?: number;
  ts: number;
}

/* ── match state ───────────────────────────────────────────────────── */

export interface MatchState {
  matchId: string;
  rulesetId: string;
  blueprint: Blueprint;
  seed: string;
  teams: TeamState[];
  participants: ParticipantState[];
  judgeModel: ModelSnapshot | null;
  round: number;
  phase: "idle" | "collecting" | "judging" | "sudden" | "done";
  /** participantId → this round's submission (present once it lands). */
  pending: Record<string, Submission>;
  history: RoundRecord[];
  suddenDeath: boolean;
  budget: CallBudget;
  paused: boolean;
  winnerTeamId: string | null;
  endReason: string | null;
  begunAt: number;
}

export type MatchAction =
  | { kind: "start"; at: number }
  | { kind: "submit"; submission: Submission }
  | { kind: "verdict"; verdict: JudgeVerdict }
  | { kind: "dm"; intervention: Intervention }
  /** Re-open one participant's turn after a cut that produced no usable answer. */
  | { kind: "recall"; participantId: string }
  | { kind: "abort"; reason: string };

/**
 * Outcome of picking a match back up after the process died. Shared by both
 * runtimes so the route and the UI never branch on the genre to read a failure.
 */
export interface RecoverResult {
  ok: boolean;
  resumed?: boolean;
  already?: boolean;
  code?: "not_found" | "finished" | "no_checkpoint" | "corrupt" | "busy";
  error?: string;
  day?: number;
  phase?: string;
  /** Seats (werewolf) or participant ids (rubric) the recovery re-issued. */
  owed?: Array<number | string>;
}

/* ── events ────────────────────────────────────────────────────────── */

export type EventType =
  | "match.created"
  | "round.opened"
  | "seat.thinking.delta"
  | "seat.submitted"
  | "seat.forfeit"
  | "round.collected"
  | "judge.thinking.delta"
  | "round.verdict"
  | "round.closed"
  | "match.finished"
  | "dm.intervened"
  | "state.updated"
  | "anomaly"
  | "board.reconciled"
  | "state.snapshot"
  /* crash recovery */
  | "match.recovered"
  | "seat.recalled"
  /* nine-seat table */
  | "roles.dealt"
  | "phase.changed"
  | "wolf.chat"
  | "seer.check"
  | "night.resolved"
  | "dawn"
  | "speech"
  | "self_destruct"
  | "vote.tally"
  | "pk.opened"
  | "exile"
  | "no_exile"
  | "hunter.shot"
  | "last_words"
  | "seat.died"
  | "seat.afk"
  /* coup table */
  | "coup.dealt"
  | "coup.turn"
  | "coup.action"
  | "coup.reaction"
  | "coup.challenge"
  | "coup.block"
  | "coup.lost"
  | "coup.forfeit"
  | "coup.result"
  | "coup.coins"
  | "coup.hand"
  | "coup.exchange"
  | "coup.commentary"
  | "coup.finished"
  /* post-game review */
  | "review.opened"
  | "review.rater.started"
  | "review.thinking.delta"
  | "review.ballot"
  | "review.verdict";

export interface ArenaEvent {
  seq: number;
  type: EventType;
  seat?: number;
  teamId?: string;
  ts: number;
  payload: Record<string, unknown>;
}

/* ── effects returned by the reducer ───────────────────────────────── */

export type Effect =
  | { kind: "emit"; event: Omit<ArenaEvent, "seq"> }
  | { kind: "call_participants"; ids: string[] }
  | { kind: "call_judge"; round: number; sudden: boolean; settlement?: Settlement | null }
  | { kind: "finish"; winnerTeamId: string | null; reason: string };

export interface ReduceResult {
  state: MatchState;
  effects: Effect[];
}
