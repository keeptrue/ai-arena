/**
 * Nine-seat werewolf domain types.
 *
 * Nothing here performs I/O. The game is a second, self-contained genre next to
 * the rubric arena: hidden roles, ordered phases, deterministic resolution.
 */

import type { ArenaEvent, CallBudget, TokenUsage } from "../types";

export type WerewolfRoleId = "wolf" | "seer" | "witch" | "hunter" | "villager";
export type WerewolfCamp = "wolf" | "good";
export type WerewolfDealMode = "engine" | "manual" | "judge";

export type WerewolfPhase =
  | "dealing"
  | "night_wolves"
  | "night_seer"
  | "night_witch"
  | "dawn"
  | "hunter_shot"
  | "day_last_words"
  | "day_speech"
  | "day_vote"
  | "day_pk_speech"
  | "day_pk_vote"
  | "done";

export type DeathCause = "wolf" | "poison" | "vote" | "hunter" | "self_destruct";

export interface WerewolfRoleSpec {
  id: WerewolfRoleId;
  label: string;
  camp: WerewolfCamp;
  count: number;
}

/**
 * The house rules are data, not code: every quirk the table agreed on lives here
 * so a variant can be declared without touching the state machine.
 */
export interface WerewolfRules {
  seerResult: "camp";
  witch: {
    antidote: number;
    poison: number;
    onePerNight: boolean;
    selfSave: "first_night" | "never" | "always";
    poisonSelf: boolean;
    seeKillAfterAntidote: boolean;
  };
  hunter: {
    shootOn: Array<"wolf" | "vote">;
    poisonBlocks: boolean;
  };
  wolf: {
    allowEmptyKill: boolean;
    allowSelfKill: boolean;
    decision: "plurality";
    tieBreak: "seed";
    chat: "sequential";
  };
  day: {
    speech: "clockwise";
    start: "after_death" | "fixed";
    vote: "plurality";
    tie: "pk" | "no_exile";
    pkVoters: "non_candidates" | "all";
    lastWords: Array<"night1" | "daytime">;
    selfDestruct: "own_speech";
    /** 面杀标准：自爆直接入夜，不留遗言。 */
    selfDestructLastWords: boolean;
    shotLastWords: boolean;
  };
  maxDays: number;
}

/**
 * Post-game review knobs. Every field is optional: `review.ts` owns the defaults,
 * so a ruleset written before this feature behaves exactly like a fresh one.
 */
export interface WerewolfReviewConfig {
  enabled?: boolean;
  /** How much a seat's own ballot counts toward its own average. 0 = display only. */
  selfWeight?: number;
  /** The judge's ballot is worth this many player ballots. */
  judgeVotes?: number;
  /** Drop one highest and one lowest peer ballot per target before averaging. */
  trim?: boolean;
  /** Below this many valid player ballots the result is provisional. */
  minBallots?: number;
  weights?: { read: number; voice: number; craft: number; poise: number };
}

export interface WerewolfBlueprint {
  mode: "werewolf";
  id: string;
  name: string;
  tagline: string;
  seats: 9;
  briefing: string;
  roles: WerewolfRoleSpec[];
  rules: WerewolfRules;
  review?: WerewolfReviewConfig;
}

export interface WerewolfSeatState {
  participantId: string;
  /** 0-based internally; the UI renders `seat + 1`. */
  seat: number;
  role: WerewolfRoleId;
  camp: WerewolfCamp;
  alive: boolean;
  death: { day: number; cause: DeathCause } | null;
  lastWords: string | null;
  /** Two consecutive failed calls: stop calling this seat, treat every action as abstain. */
  afk: boolean;
  forfeitsInARow: number;
  /** Phase this seat last failed in; a manual recall is only legal inside it. */
  lastForfeitPhase: WerewolfPhase | null;
}

export interface WerewolfCheck {
  day: number;
  target: number;
  result: "wolf" | "good";
}

export interface WerewolfNightState {
  /** 商量轮 = 低语 + 倾向票；定刀轮 = 看完第一轮提议后的最终票。 */
  wolfStage: "discuss" | "decide";
  wolfVotes: Record<number, number | "empty">;
  wolfTalk: Array<{ seat: number; text: string }>;
  killTarget: number | null;
  saved: boolean;
  poisonTarget: number | null;
  seerTarget: number | null;
  seerResult: "wolf" | "good" | null;
}

export type PublicEntry =
  | { kind: "dawn"; day: number; deaths: number[] }
  | { kind: "speech"; day: number; seat: number; text: string; pk?: boolean }
  | { kind: "self_destruct"; day: number; seat: number }
  | {
      kind: "vote";
      day: number;
      counts: Record<number, number>;
      votes?: Record<number, number | "abstain">;
      exiled: number | null;
      tie: number[];
    }
  | { kind: "exile"; day: number; seat: number }
  | { kind: "no_exile"; day: number; reason: "tie" | "abstain" }
  | { kind: "hunter_shot"; day: number; seat: number; target: number | null }
  | { kind: "last_words"; day: number; seat: number; text: string }
  | { kind: "system"; day: number; text: string };

export type PhaseAction =
  | { kind: "wolf"; target: number | "empty"; talk: string }
  | { kind: "seer"; target: number }
  | { kind: "witch"; action: "save" | "poison" | "none"; target: number | null }
  | { kind: "speech"; text: string; selfDestruct?: boolean }
  | { kind: "vote"; target: number | "abstain" }
  | { kind: "hunter"; target: number | "pass" }
  | { kind: "last_words"; text: string };

export interface WerewolfSubmission {
  seat: number;
  phase: WerewolfPhase;
  status: "ready" | "forfeit";
  action: PhaseAction | null;
  /** 写给观众的旁白（提交 JSON 的 note 字段；兼容旧的 <<<THINK>>> 草稿）。 */
  thinking: string;
  /** 模型 reasoning 通道的原文；和 thinking 分开存，UI 才能分层。 */
  reasoning: string;
  raw: string;
  usage: TokenUsage;
  latencyMs: number;
  anomalies: string[];
}

export interface WerewolfHunterTrigger {
  seat: number;
  resume: "dawn" | "exile";
}

export interface WerewolfState {
  matchId: string;
  spec: WerewolfBlueprint;
  seed: string;
  dealSource: WerewolfDealMode | "engine_fallback";
  seats: WerewolfSeatState[];
  day: number;
  phase: WerewolfPhase;
  night: WerewolfNightState;
  potions: { antidote: number; poison: number };
  checks: WerewolfCheck[];
  votes: Record<number, number | "abstain">;
  pk: { candidates: number[]; votes: Record<number, number | "abstain"> } | null;
  pending: Record<number, PhaseAction>;
  /** Seats that act in the current phase, in call order. */
  queue: number[];
  /**
   * Seats re-opened by hand after a false cut. Their turn already passed, so
   * `submit` accepts a late answer from them for the rest of this phase.
   */
  recalled: number[];
  /** How many of `queue` have been called. Sequential phases call one at a time. */
  queueIndex: number;
  /** `parallel` phases fire every call at once; `sequential` waits for each speaker. */
  callMode: "sequential" | "parallel";
  publicLog: PublicEntry[];
  lastSpeaker: number | null;
  deathsTonight: number[];
  deathsToday: number[];
  wordsQueue: number[];
  wordsNext: "day" | "night";
  hunterTrigger: WerewolfHunterTrigger | null;
  selfDestruct: number | null;
  winner: WerewolfCamp | null;
  endReason: string | null;
  startedAt: number;
  budget: CallBudget;
}

export type WerewolfAction =
  | { kind: "start"; at: number }
  | { kind: "submit"; submission: WerewolfSubmission }
  /** Re-open one seat's turn inside the phase it failed in. */
  | { kind: "recall"; seat: number }
  | { kind: "abort"; reason: string };

export type WerewolfEffect =
  | { kind: "emit"; event: Omit<ArenaEvent, "seq"> }
  /** `stage` separates the discussion call from the deciding call in the wolf night. */
  | { kind: "call_seat"; seat: number; phase: WerewolfPhase; stage?: "discuss" | "decide" }
  | { kind: "finish"; winner: WerewolfCamp | null; reason: string };

export interface WerewolfReduceResult {
  state: WerewolfState;
  effects: WerewolfEffect[];
}

/** What a seat is allowed to know at prompt time. */
export interface WerewolfSeatView {
  seat: WerewolfSeatState;
  teammates: number[];
  checks: WerewolfCheck[];
  wolfTalk: Array<{ seat: number; text: string }>;
  /** Wolves only: which night stage is open, and the first-round proposals. */
  wolfStage: "discuss" | "decide" | null;
  wolfProposals: Array<{ seat: number; target: number | "empty" }>;
  killTarget: number | null;
  legalTargets: number[];
  legalVotes: number[];
}
