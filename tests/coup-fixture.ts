/**
 * Shared fixtures for the Coup reducer tests.
 *
 * Everything here is pure: a blueprint literal, a seeded state, and a couple of
 * helpers that keep the tests reading like a real table.
 */

import { createCoupState } from "../src/engine/coup/reduce";
import { reduceCoup } from "../src/engine/coup/reduce";
import type {
  CoupBlueprint,
  CoupMove,
  CoupPhase,
  CoupState,
  CoupSubmission,
} from "../src/engine/coup/types";

export function buildCoupBlueprint(overrides: Partial<CoupBlueprint["rules"]> = {}): CoupBlueprint {
  return {
    mode: "coup",
    id: "coup-four",
    name: "政变 · 四人桌",
    tagline: "四人、十五张牌、七枚政变。",
    seats: 4,
    briefing:
      "四名玩家各持两张暗牌与两枚金币。每回合做一件事：收入、外援、政变、征税、刺杀、偷窃或换牌。宣称身份可以撒谎，其他人可以质疑；质疑失败的人掉一条命，被质疑者亮不出牌时行动作废、已付金币退回。最后还有牌的玩家获胜。",
    roles: [
      { id: "duke", label: "公爵", count: 3 },
      { id: "assassin", label: "刺客", count: 3 },
      { id: "captain", label: "队长", count: 3 },
      { id: "ambassador", label: "大使", count: 3 },
      { id: "contessa", label: "伯爵夫人", count: 3 },
    ],
    rules: {
      startingCoins: 2,
      coupCost: 7,
      forcedCoupAt: 10,
      stealCap: 2,
      assassinateCost: 3,
      deckExhausted: "draw_as_many",
      maxTurns: 60,
      ...overrides,
    },
  };
}

export function buildCoupState(input: {
  seed?: string;
  spec?: CoupBlueprint;
  seats?: number;
} = {}): CoupState {
  const seats = input.seats ?? 4;
  const state = createCoupState({
    matchId: "m_test",
    spec: input.spec ?? buildCoupBlueprint(),
    seed: input.seed ?? "seed-coup",
    seats: Array.from({ length: seats }, (_, i) => ({ participantId: `p${i}`, seat: i })),
    budget: { maxCalls: 400 },
    at: 1_700_000_000_000,
  });
  return state;
}

/** Create a state and hand out the opening move. */
export function startCoup(input: { seed?: string; spec?: CoupBlueprint; seats?: number } = {}): CoupState {
  const state = buildCoupState(input);
  return play(state, { kind: "start", at: 1_700_000_000_000 });
}

export function play(state: CoupState, action: Parameters<typeof reduceCoup>[1]): CoupState {
  return reduceCoup(state, action).state;
}

export function effectsOf(state: CoupState, action: Parameters<typeof reduceCoup>[1]) {
  return reduceCoup(state, action).effects;
}

function submission(state: CoupState, seat: number, move: CoupMove): CoupSubmission {
  return {
    seat,
    phase: state.phase,
    status: "ready",
    move,
    thinking: "",
    reasoning: "",
    raw: "",
    usage: { promptTokens: 0, completionTokens: 0 },
    latencyMs: 0,
    anomalies: [],
  };
}

/** Submit one move for `seat` in the current phase. */
export function act(state: CoupState, seat: number, move: CoupMove): CoupState {
  return play(state, { kind: "submit", submission: submission(state, seat, move) });
}

export function forfeit(state: CoupState, seat: number): CoupState {
  return play(state, {
    kind: "submit",
    submission: { ...submission(state, seat, { kind: "flip", index: 0 }), status: "forfeit", move: null },
  });
}

/** The seat whose input the engine is waiting for, or null. */
export function waiting(state: CoupState): number[] {
  if (state.phase === "done" || state.phase === "dealing") return [];
  return state.queue.filter((seat) => state.pending[seat] === undefined);
}

export function phaseOf(state: CoupState): CoupPhase {
  return state.phase;
}

/** Hand every waiting seat a pass, then return the settled state. */
export function passAll(state: CoupState): CoupState {
  let next = state;
  for (let guard = 0; guard < 8; guard++) {
    const owed = waiting(next);
    if (owed.length === 0) return next;
    for (const seat of owed) {
      next = act(next, seat, { kind: "react", reaction: "pass", as: null, say: "" });
    }
    if (next.phase !== "action_reaction" && next.phase !== "block_reaction") return next;
  }
  return next;
}

/** Count every card in the match, wherever it sits. */
export function cardCount(state: CoupState): number {
  return (
    state.deck.length +
    state.seats.reduce((n, s) => n + s.cards.length + s.revealed.length, 0)
  );
}
