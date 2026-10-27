/**
 * Coup domain types.
 *
 * Nothing here performs I/O. Coup is the third genre next to the rubric arena and
 * the nine-seat table: hidden hands, a challenge chain, deterministic resolution.
 *
 * The engine owns every fact — who loses an influence, whether a challenge
 * succeeds, how coins move. Models only declare intent.
 */

import type { ArenaEvent } from "../types";

export const COUP_ROLES = ["duke", "assassin", "captain", "ambassador", "contessa"] as const;
export type CoupRole = (typeof COUP_ROLES)[number];

export const COUP_ACTIONS = [
  "income",
  "foreign_aid",
  "coup",
  "tax",
  "steal",
  "assassinate",
  "exchange",
] as const;
export type CoupActionKind = (typeof COUP_ACTIONS)[number];

/** Actions that require claiming a role, and therefore can be challenged. */
export const ROLE_ACTIONS: Record<CoupActionKind, CoupRole | null> = {
  income: null,
  foreign_aid: null,
  coup: null,
  tax: "duke",
  steal: "captain",
  assassinate: "assassin",
  exchange: "ambassador",
};

/** Which role blocks which action, and who is allowed to claim it. */
export const BLOCKERS: Partial<
  Record<CoupActionKind, { roles: CoupRole[]; scope: "anyone" | "target" }>
> = {
  foreign_aid: { roles: ["duke"], scope: "anyone" },
  steal: { roles: ["captain", "ambassador"], scope: "target" },
  assassinate: { roles: ["contessa"], scope: "target" },
};

export type CoupPhase =
  | "dealing"
  | "action_select"
  | "action_reaction"
  | "block_reaction"
  | "influence_lose"
  | "exchange_pick"
  | "done";

export type LossCause = "challenge_lost" | "challenge_failed" | "assassinated" | "coup";

export interface CoupCard {
  id: string;
  role: CoupRole;
}

export interface CoupSeatState {
  participantId: string;
  /** 0-based internally; the UI renders `seat + 1`. */
  seat: number;
  coins: number;
  /** Face-down cards. Order is the `flip` index the model picks from. */
  cards: CoupCard[];
  revealed: Array<CoupCard & { turn: number; cause: LossCause }>;
  alive: boolean;
  afk: boolean;
  forfeitsInARow: number;
  /** Phase this seat last failed in; a manual recall is only legal inside it. */
  lastForfeitPhase: CoupPhase | null;
  /** Counters for the post-game review; never fed back into play. */
  stats: { claims: number; bluffs: number; challenges: number; hits: number };
  /** Every claim this seat made, with the audience-only truth flag. */
  history: Array<{
    turn: number;
    action: CoupActionKind;
    role: CoupRole | null;
    target: number | null;
    honest: boolean;
  }>;
}

export interface CoupClaim {
  seat: number;
  action: CoupActionKind;
  role: CoupRole | null;
  target: number | null;
  say: string;
}

export type CoupReactionKind = "pass" | "challenge" | "block";

export interface CoupReaction {
  seat: number;
  kind: CoupReactionKind;
  /** Set when `kind === "block"`. */
  as: CoupRole | null;
  say: string;
  /** 写给观众的旁白（`note`），只进事件流与解说，绝不进对手 prompt。 */
  note: string;
  /** True when the seat never produced a legal reaction; the pass is an accident. */
  forfeit: boolean;
  anomalies: string[];
}

/**
 * The resolution script. `pump()` consumes one step at a time and only stops for
 * input when a seat must choose *which* card to flip or *which* cards to keep.
 */
export type CoupStep =
  | { kind: "gain"; seat: number; coins: number }
  | { kind: "pay"; seat: number; coins: number }
  | { kind: "refund"; seat: number; coins: number }
  | { kind: "transfer"; from: number; to: number; coins: number }
  | { kind: "lose"; seat: number; cause: LossCause }
  | { kind: "prove"; seat: number; role: CoupRole }
  | { kind: "exchange"; seat: number }
  | { kind: "void"; reason: "challenge" | "block" };

/** What the model actually submitted, already coerced to a legal shape. */
export type CoupMove =
  | { kind: "act"; action: CoupActionKind; target: number | null; say: string }
  | { kind: "react"; reaction: CoupReactionKind; as: CoupRole | null; say: string }
  | { kind: "flip"; index: number }
  | { kind: "exchange"; keep: string[] };

export interface CoupSubmission {
  seat: number;
  phase: CoupPhase;
  status: "ready" | "forfeit";
  move: CoupMove | null;
  /** 写给观众的旁白。对手不可见。 */
  thinking: string;
  /** 模型 reasoning 通道原文；和 thinking 分开存。 */
  reasoning: string;
  raw: string;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  anomalies: string[];
}

/** One public line. `text` goes into prompts (≤40 chars); `detail` is UI-only. */
export interface CoupLogEntry {
  turn: number;
  kind: "deal" | "action" | "challenge" | "block" | "result" | "lost" | "system";
  seat: number | null;
  text: string;
  detail?: string;
}

export interface CoupRules {
  startingCoins: number;
  coupCost: number;
  forcedCoupAt: number;
  stealCap: number;
  assassinateCost: number;
  deckExhausted: "draw_as_many";
  maxTurns: number;
}

export interface CoupRoleSpec {
  id: CoupRole;
  label: string;
  count: number;
}

export interface CoupReviewConfig {
  enabled?: boolean;
  selfWeight?: number;
  judgeVotes?: number;
  trim?: boolean;
  minBallots?: number;
  weights?: { bluff?: number; read?: number; tempo?: number; poise?: number };
}

export interface CoupBlueprint {
  mode: "coup";
  id: string;
  name: string;
  tagline: string;
  seats: 4;
  briefing: string;
  roles: CoupRoleSpec[];
  rules: CoupRules;
  commentary?: { modelId?: string | null };
  review?: CoupReviewConfig;
}

export interface CoupState {
  matchId: string;
  spec: CoupBlueprint;
  seed: string;
  seats: CoupSeatState[];
  deck: CoupCard[];
  turn: number;
  phase: CoupPhase;
  /** Seat whose turn it is; `null` between turns and after the game ends. */
  actor: number | null;
  /** The claim currently being resolved. */
  claim: CoupClaim | null;
  /** Reactions to the claim, one per eligible seat. */
  reactions: CoupReaction[];
  /** Set once a block is declared; reactions to the block live in `blockReactions`. */
  blocker: { seat: number; as: CoupRole; say: string; note: string } | null;
  blockReactions: CoupReaction[];
  script: CoupStep[];
  /** Where to go once the script drains after a challenge let the claim survive:
   *  `block_window` when a block was declared, `effect` when the action should
   *  simply resolve. `null` means the turn ends. */
  resume: "block_window" | "effect" | null;
  /** Set while a seat must choose which face-down card to flip. */
  pendingFlip: { seat: number; cause: LossCause } | null;
  /** Set while a seat must pick which cards to keep after an Exchange. */
  pendingExchange: { seat: number; drawn: CoupCard[] } | null;
  /** Seats that answer the current phase, in call order. */
  queue: number[];
  queueIndex: number;
  callMode: "sequential" | "parallel";
  /** Seats re-opened by hand after a false cut. */
  recalled: number[];
  pending: Record<number, CoupSubmission>;
  publicLog: CoupLogEntry[];
  /** Index of the winning seat, or `null` on a draw. */
  winner: number | null;
  endReason: string | null;
  startedAt: number;
  budget: { maxCalls: number; calls: number; tokens: number };
}

export type CoupAction =
  | { kind: "start"; at: number }
  | { kind: "submit"; submission: CoupSubmission }
  | { kind: "recall"; seat: number }
  | { kind: "abort"; reason: string };

export type CoupEffect =
  | { kind: "emit"; event: Omit<ArenaEvent, "seq"> }
  | { kind: "call_seat"; seat: number; phase: CoupPhase }
  | { kind: "finish"; winner: number | null; reason: string };

export interface CoupReduceResult {
  state: CoupState;
  effects: CoupEffect[];
}

/** What a seat is allowed to know at prompt time. Never includes other hands. */
export interface CoupSeatView {
  seat: CoupSeatState;
  hand: CoupCard[];
  revealed: Array<{ role: CoupRole; turn: number }>;
  coins: number;
  deckCount: number;
  /** Legal moves for the phase this seat was called into. */
  legal: {
    actions: CoupActionKind[];
    targets: number[];
    reactions: CoupReactionKind[];
    blockRoles: CoupRole[];
    forcedCoup: boolean;
    /** Seats that may be challenged this phase, for the reaction prompt. */
    claim: CoupClaim | null;
    flipCount: number;
  };
}
