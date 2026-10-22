/** Core domain types for the rule-driven arena. Nothing here performs I/O. */

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

export interface RubricDimension {
  key: string;
  label: string;
  weight: number;
  hint: string;
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

export interface BoardSpec {
  meters: BoardMeter[];
  /** Declares that the board has disposable marks (mines): judge returns `marks: number[]`. */
  marks?: { label: string };
}

export interface Blueprint {
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
  blueprint: Blueprint;
  blueprintHash: string;
  compiledAt: number | null;
  compiledBy: string | null;
  enabled: boolean;
}

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
  usage: { promptTokens: number; completionTokens: number };
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

export interface JudgeVerdict {
  round: number;
  /** "A" | "B" | … → teamId. Re-drawn every round. */
  blindMap: Record<string, string>;
  scores: TeamScoreLine[];
  verdict: string;
  publicSummary: string;
  judgeModel: ModelSnapshot;
  usage: { promptTokens: number; completionTokens: number };
  /** Set only on a sudden-death round: the judge names a winner outright. */
  suddenWinnerTeamId?: string | null;
  /** Squares currently occupied by a disposable mark (mines), when the board declares `marks`. */
  marks?: number[];
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
}

/* ── interventions ─────────────────────────────────────────────────── */

export type InterventionKind = "pause" | "resume" | "say" | "rule" | "score" | "forfeit";

export interface Intervention {
  id: string;
  kind: InterventionKind;
  text?: string;
  teamId?: string;
  participantId?: string;
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
  budget: { maxCalls: number; maxTokens: number; calls: number; tokens: number };
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
  | { kind: "abort"; reason: string };

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
  | "state.snapshot";

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
  | { kind: "call_judge"; round: number; sudden: boolean }
  | { kind: "finish"; winnerTeamId: string | null; reason: string };

export interface ReduceResult {
  state: MatchState;
  effects: Effect[];
}
