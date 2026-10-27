/**
 * Coup reducer. Pure: (state, action) -> (state, effects).
 *
 * The engine owns every fact: who loses an influence, whether a challenge holds,
 * how coins move. Models only declare intent.
 *
 * Resolution is a small script machine: a claim produces an ordered list of
 * `CoupStep`s, and `pump()` walks it until it needs a decision the model must
 * make (which card to flip, which cards to keep). Everything else is arithmetic.
 */

import { shuffle } from "../rng";
import type { ArenaEvent } from "../types";
import { dealCards, holds } from "./deal";
import { BLOCKERS, ROLE_ACTIONS } from "./types";
import type {
  CoupAction,
  CoupActionKind,
  CoupBlueprint,
  CoupCard,
  CoupClaim,
  CoupEffect,
  CoupLogEntry,
  CoupMove,
  CoupPhase,
  CoupReaction,
  CoupReduceResult,
  CoupRole,
  CoupSeatState,
  CoupSeatView,
  CoupState,
  CoupStep,
  CoupSubmission,
  LossCause,
} from "./types";

export interface CoupSeatInput {
  participantId: string;
  seat: number;
}

/* ── construction ──────────────────────────────────────────────────── */

export function createCoupState(input: {
  matchId: string;
  spec: CoupBlueprint;
  seed: string;
  seats: CoupSeatInput[];
  budget: { maxCalls: number };
  at: number;
}): CoupState {
  const { hands, deck } = dealCards(input.seed, input.seats.length);
  return {
    matchId: input.matchId,
    spec: input.spec,
    seed: input.seed,
    seats: input.seats.map((s, i) => ({
      participantId: s.participantId,
      seat: s.seat,
      coins: input.spec.rules.startingCoins,
      cards: hands[i],
      revealed: [],
      alive: true,
      afk: false,
      forfeitsInARow: 0,
      lastForfeitPhase: null,
      stats: { claims: 0, bluffs: 0, challenges: 0, hits: 0 },
      history: [],
    })),
    deck,
    turn: 0,
    phase: "dealing",
    actor: null,
    claim: null,
    reactions: [],
    blocker: null,
    blockReactions: [],
    script: [],
    resume: null,
    pendingFlip: null,
    pendingExchange: null,
    queue: [],
    queueIndex: 0,
    callMode: "sequential",
    recalled: [],
    pending: {},
    publicLog: [],
    winner: null,
    endReason: null,
    startedAt: input.at,
    budget: { maxCalls: input.budget.maxCalls, calls: 0, tokens: 0 },
  };
}

/* ── entry ─────────────────────────────────────────────────────────── */

export function reduceCoup(state: CoupState, action: CoupAction): CoupReduceResult {
  if (action.kind === "abort") {
    const next = clone(state);
    const effects: CoupEffect[] = [];
    finishGame(next, effects, null, `aborted:${action.reason}`);
    return { state: next, effects };
  }
  if (action.kind === "start") {
    if (state.phase !== "dealing") return { state, effects: [] };
    const next = clone(state);
    const effects: CoupEffect[] = [];
    start(next, effects, action.at);
    return { state: next, effects };
  }
  if (state.phase === "done" || state.phase === "dealing") return { state, effects: [] };
  if (action.kind === "recall") return recallSeat(state, action.seat);
  return submit(state, action.submission);
}

/* ── start ─────────────────────────────────────────────────────────── */

function start(state: CoupState, effects: CoupEffect[], at: number): void {
  state.startedAt = at;
  state.turn = 1;
  state.phase = "action_select";
  // `null` so the clockwise walk from the seat before 0 lands on seat 0.
  state.actor = null;

  emit(effects, "match.created", {
    matchId: state.matchId,
    kind: "coup",
    name: state.spec.name,
    tagline: state.spec.tagline,
    briefing: state.spec.briefing,
    seats: state.seats.map((s) => ({ participantId: s.participantId, seat: s.seat })),
    rules: state.spec.rules,
  });
  emit(effects, "coup.dealt", {
    deck: state.deck.length,
    hands: state.seats.map((s) => ({ seat: s.seat, cards: s.cards })),
    coins: state.seats.map((s) => ({ seat: s.seat, coins: s.coins })),
  });

  log(state, {
    turn: 0,
    kind: "deal",
    seat: null,
    text: `四人各得两张暗牌、${state.spec.rules.startingCoins} 枚金币，牌堆 ${state.deck.length} 张。`,
  });

  beginTurn(state, effects);
}

function beginTurn(state: CoupState, effects: CoupEffect[]): void {
  if (checkEnd(state, effects)) return;
  state.phase = "action_select";
  state.claim = null;
  state.reactions = [];
  state.blocker = null;
  state.blockReactions = [];
  state.script = [];
  state.pendingFlip = null;
  state.pendingExchange = null;
  state.recalled = [];

  const actor = nextActor(state);
  if (actor === null) {
    finishGame(state, effects, null, "no_alive");
    return;
  }
  state.actor = actor;
  enterPhase(state, effects, "action_select", [actor], "sequential");

  emit(effects, "coup.turn", {
    turn: state.turn,
    actor,
    forcedCoup: mustCoup(state, actor),
    coins: state.seats.map((s) => ({ seat: s.seat, coins: s.coins })),
    deck: state.deck.length,
    alive: state.seats.filter((s) => s.alive).map((s) => s.seat),
  });
}

function nextActor(state: CoupState): number | null {
  const alive = state.seats.filter((s) => s.alive).map((s) => s.seat);
  if (alive.length === 0) return null;
  const from = state.actor === null ? -1 : state.actor;
  for (let step = 1; step <= state.seats.length; step++) {
    const seat = (from + step) % state.seats.length;
    if (state.seats[seat].alive) return seat;
  }
  return alive[0] ?? null;
}

function mustCoup(state: CoupState, seat: number): boolean {
  return state.seats[seat].coins >= state.spec.rules.forcedCoupAt;
}

/* ── submissions ───────────────────────────────────────────────────── */

function submit(state: CoupState, submission: CoupSubmission): CoupReduceResult {
  const next = clone(state);
  const effects: CoupEffect[] = [];
  if (submission.phase !== next.phase) return { state, effects: [] };

  const inTurn =
    next.callMode === "parallel"
      ? next.queue.includes(submission.seat)
      : next.queue[next.queueIndex - 1] === submission.seat;
  if (!inTurn && !next.recalled.includes(submission.seat)) return { state, effects: [] };
  if (next.pending[submission.seat] !== undefined) return { state, effects: [] };

  next.pending[submission.seat] = submission;
  trackSubmission(next, submission);

  const owed = next.queue.filter((seat) => next.pending[seat] === undefined);
  if (owed.length > 0) return { state: next, effects };

  advance(next, effects);
  return { state: next, effects };
}

function trackSubmission(state: CoupState, submission: CoupSubmission): void {
  const seat = state.seats[submission.seat];
  if (!seat) return;
  if (submission.status === "forfeit") {
    seat.forfeitsInARow += 1;
    seat.lastForfeitPhase = state.phase;
  } else {
    seat.forfeitsInARow = 0;
    seat.lastForfeitPhase = null;
  }
}

/* ── phase advance ─────────────────────────────────────────────────── */

function advance(state: CoupState, effects: CoupEffect[]): void {
  switch (state.phase) {
    case "action_select":
      return advanceAction(state, effects);
    case "action_reaction":
      return advanceReaction(state, effects);
    case "block_reaction":
      return advanceBlockReaction(state, effects);
    case "influence_lose":
      return advanceFlip(state, effects);
    case "exchange_pick":
      return advanceExchange(state, effects);
    default:
      return;
  }
}

function advanceAction(state: CoupState, effects: CoupEffect[]): void {
  const actor = state.actor;
  if (actor === null) return finishGame(state, effects, null, "no_actor");
  const submission = state.pending[actor];
  const move = submission?.status === "ready" ? submission.move : null;

  // A forfeit at this phase is an income, never a fabricated claim. The audience
  // must still be told: rendering it as a deliberate income is a lie.
  const raw = state.pending[actor];
  const picked: CoupMove =
    move && move.kind === "act" ? move : { kind: "act", action: "income", target: null, say: "" };
  if (picked.kind !== "act") {
    return finishGame(state, effects, null, "invalid_actor_move");
  }
  const forfeit =
    !raw || raw.status !== "ready" || !raw.move || raw.move.kind !== "act"
      ? { anomalies: raw?.anomalies?.length ? raw.anomalies : ["no_submission"] }
      : null;

  const action = legalAction(state, actor, picked.action);
  if (!action) {
    // Illegal action: fall back to income rather than inventing a claim.
    return beginClaim(
      state,
      effects,
      actor,
      { kind: "act", action: "income", target: null, say: "" },
      forfeit ?? { anomalies: ["invalid_move"] },
    );
  }
  // `legalAction` only knows the default target; the seat's own choice wins.
  const target = action.target !== null ? (picked.target ?? action.target) : null;
  return beginClaim(state, effects, actor, { ...action, target }, forfeit);
}

function beginClaim(
  state: CoupState,
  effects: CoupEffect[],
  actor: number,
  move: Extract<CoupMove, { kind: "act" }>,
  forfeit?: { anomalies: string[] } | null,
): void {
  const role = ROLE_ACTIONS[move.action];
  // Costs are paid when the claim is made, not when it resolves: a blocked or
  // challenged action loses the coins, a successfully challenged one gets them back.
  const paid = costOf(state, move.action);
  if (paid > 0) {
    const payer = state.seats[actor];
    payer.coins = Math.max(0, payer.coins - paid);
  }
  const claim: CoupClaim = {
    seat: actor,
    action: move.action,
    role,
    target: move.target,
    say: clip(move.say, 200),
  };
  state.claim = claim;

  // Audience-only truth flag: did the claim match the hand *at claim time*?
  // Computed here rather than in the UI so a later prove/exchange cannot flip it.
  const actorSeat = state.seats[actor];
  const honest = role ? holds(actorSeat.cards, role) : null;
  const note = clip(state.pending[actor]?.thinking ?? "", 300);
  if (role) {
    actorSeat.stats.claims += 1;
    if (honest === false) actorSeat.stats.bluffs += 1;
    actorSeat.history.push({
      turn: state.turn,
      action: move.action,
      role,
      target: move.target,
      honest: honest === true,
    });
  }

  const blockedBy = BLOCKERS[move.action];
  const challengeable = role !== null;

  emit(effects, "coup.action", {
    turn: state.turn,
    seat: actor,
    action: move.action,
    role,
    target: move.target,
    say: claim.say,
    note,
    honest,
    challengeable,
    blockable: !!blockedBy,
    paid,
    coinsAfter: state.seats[actor].coins,
    forfeit: !!forfeit,
    anomalies: forfeit?.anomalies ?? [],
  });
  // After the action: the action event starts a fresh turn draft.
  if (forfeit) {
    emit(effects, "coup.forfeit", {
      turn: state.turn,
      seat: actor,
      phase: "action_select",
      anomalies: forfeit.anomalies,
    });
  }
  if (paid > 0) {
    emitCoins(state, effects, [{ seat: actor, before: state.seats[actor].coins + paid }]);
  }
  log(state, {
    turn: state.turn,
    kind: "action",
    seat: actor,
    text: `${seatTag(actor)} 宣称${role ? roleName(state, role) + '·' : ''}${actionName(move.action)}${
      move.target !== null ? ` → ${seatTag(move.target)}` : ""
    }。`,
    detail: claim.say,
  });

  // Income and coup are neither challengeable nor blockable.
  if (!challengeable && !blockedBy) {
    state.script.push(...effectSteps(state, claim));
    return pump(state, effects);
  }

  const eligible = aliveSeats(state).filter((s) => s !== actor);
  state.reactions = [];
  enterPhase(state, effects, "action_reaction", eligible, "parallel");
}

function advanceReaction(state: CoupState, effects: CoupEffect[]): void {
  const claim = state.claim;
  if (!claim) return finishGame(state, effects, null, "no_claim");

  const reactions = collectReactions(state);
  state.reactions = reactions;
  for (const r of reactions) {
    emit(effects, "coup.reaction", {
      turn: state.turn,
      seat: r.seat,
      kind: r.kind,
      as: r.as,
      say: r.say,
      note: r.note,
      forfeit: r.forfeit,
      anomalies: r.anomalies,
    });
    if (r.kind !== "pass") {
      log(state, {
        turn: state.turn,
        kind: r.kind === "challenge" ? "challenge" : "block",
        seat: r.seat,
        text: `${seatTag(r.seat)} ${r.kind === "challenge" ? "质疑" : `以${roleName(state, r.as!)}阻挡`}。`,
        detail: r.say,
      });
    }
  }

  const challenger = firstClockwise(state, claim.seat, reactions.filter((r) => r.kind === "challenge"));
  if (challenger) {
    const actor = state.seats[claim.seat];
    const challengerSeat = state.seats[challenger.seat];
    challengerSeat.stats.challenges += 1;
    const holdsIt = holds(actor.cards, claim.role);

    if (holdsIt) {
      challengerSeat.stats.hits += 0;
      state.script.push({ kind: "lose", seat: challenger.seat, cause: "challenge_lost" });
      state.script.push({ kind: "prove", seat: claim.seat, role: claim.role! });
      emit(effects, "coup.challenge", {
        turn: state.turn,
        challenger: challenger.seat,
        target: claim.seat,
        holds: true,
        role: claim.role,
        about: "claim",
      });
      log(state, {
        turn: state.turn,
        kind: "challenge",
        seat: challenger.seat,
        text: `质疑失败：${seatTag(claim.seat)} 亮出${roleName(state, claim.role!)}，${seatTag(challenger.seat)} 掉一条命。`,
      });
      // The claim survives; a block declared in the same window still applies,
      // but only after the challenge has fully resolved.
      const hasBlock = reactions.some((r) => r.kind === "block");
      state.resume = hasBlock ? "block_window" : "effect";
      return pump(state, effects);
    }

    state.script.push({ kind: "lose", seat: claim.seat, cause: "challenge_failed" });
    if (claim.action === "assassinate") {
      state.script.push({ kind: "refund", seat: claim.seat, coins: state.spec.rules.assassinateCost });
    }
    state.script.push({ kind: "void", reason: "challenge" });
    state.resume = null;
    emit(effects, "coup.challenge", {
      turn: state.turn,
      challenger: challenger.seat,
      target: claim.seat,
      holds: false,
      role: claim.role,
      about: "claim",
    });
    log(state, {
      turn: state.turn,
      kind: "challenge",
      seat: challenger.seat,
      text: `质疑成立：${seatTag(claim.seat)} 没有${roleName(state, claim.role ?? "duke")}，行动作废，已付金币退回。`,
    });
    return pump(state, effects);
  }

  return openBlockWindow(state, effects);
}

/** Nobody challenged the claim; a declared block now goes to its own window. */
function openBlockWindow(state: CoupState, effects: CoupEffect[]): void {
  const claim = state.claim;
  if (!claim) return advanceTurn(state, effects);
  const blocker = firstClockwise(state, claim.seat, state.reactions.filter((r) => r.kind === "block"));
  if (blocker && BLOCKERS[claim.action]) {
    state.blocker = { seat: blocker.seat, as: blocker.as!, say: blocker.say, note: blocker.note };
    emit(effects, "coup.block", {
      turn: state.turn,
      seat: blocker.seat,
      as: blocker.as,
      say: blocker.say,
      note: blocker.note,
    });
    const eligible = aliveSeats(state).filter((s) => s !== blocker.seat);
    state.blockReactions = [];
    enterPhase(state, effects, "block_reaction", eligible, "parallel");
    return;
  }
  state.script.push(...effectSteps(state, claim));
  pump(state, effects);
}

function advanceBlockReaction(state: CoupState, effects: CoupEffect[]): void {
  const claim = state.claim;
  const blocker = state.blocker;
  if (!claim || !blocker) return finishGame(state, effects, null, "no_block");

  const reactions = collectReactions(state);
  state.blockReactions = reactions;
  for (const r of reactions) {
    if (r.kind === "pass") continue;
    emit(effects, "coup.reaction", {
      turn: state.turn,
      seat: r.seat,
      kind: "challenge",
      as: null,
      say: r.say,
      note: r.note,
      forfeit: r.forfeit,
      anomalies: r.anomalies,
      about: "block",
    });
  }

  const challenger = firstClockwise(state, blocker.seat, reactions.filter((r) => r.kind === "challenge"));
  if (challenger) {
    const seat = state.seats[blocker.seat];
    const holdsIt = holds(seat.cards, blocker.as);
    emit(effects, "coup.challenge", {
      turn: state.turn,
      challenger: challenger.seat,
      target: blocker.seat,
      holds: holdsIt,
      role: blocker.as,
      about: "block",
    });
    if (holdsIt) {
      state.script.push({ kind: "lose", seat: challenger.seat, cause: "challenge_lost" });
      state.script.push({ kind: "prove", seat: blocker.seat, role: blocker.as });
      state.script.push({ kind: "void", reason: "block" });
      log(state, {
        turn: state.turn,
        kind: "challenge",
        seat: challenger.seat,
        text: `质疑阻挡失败：${seatTag(blocker.seat)} 翻开${roleName(state, blocker.as)}，行动被挡下。`,
      });
    } else {
      state.script.push({ kind: "lose", seat: blocker.seat, cause: "challenge_failed" });
      state.script.push(...effectSteps(state, claim));
      log(state, {
        turn: state.turn,
        kind: "challenge",
        seat: challenger.seat,
        text: `质疑阻挡成立：${seatTag(blocker.seat)} 没有${roleName(state, blocker.as)}，阻挡失效，行动生效。`,
      });
    }
    return pump(state, effects);
  }

  state.script.push({ kind: "void", reason: "block" });
  log(state, {
    turn: state.turn,
    kind: "block",
    seat: blocker.seat,
    text: `${seatTag(blocker.seat)} 的${roleName(state, blocker.as)}阻挡成立，行动失败。`,
  });
  return pump(state, effects);
}

function advanceFlip(state: CoupState, effects: CoupEffect[]): void {
  const pending = state.pendingFlip;
  if (!pending) return finishGame(state, effects, null, "no_pending_flip");
  const submission = state.pending[pending.seat];
  const move = submission?.status === "ready" ? submission.move : null;
  const index = move && move.kind === "flip" ? move.index : 0;
  if (!move || move.kind !== "flip") {
    emit(effects, "coup.forfeit", {
      turn: state.turn,
      seat: pending.seat,
      phase: "influence_lose",
      anomalies: submission?.anomalies?.length ? submission.anomalies : ["no_flip"],
    });
  }

  const card = applyLose(state, pending.seat, pending.cause, index);
  state.pendingFlip = null;
  state.script.shift();
  if (card) {
    emit(effects, "coup.lost", {
      turn: state.turn,
      seat: pending.seat,
      role: card.role,
      cause: pending.cause,
      remaining: state.seats[pending.seat].cards.length,
    });
    log(state, {
      turn: state.turn,
      kind: "lost",
      seat: pending.seat,
      text: `${seatTag(pending.seat)} 翻开${roleName(state, card.role)}，剩 ${state.seats[pending.seat].cards.length} 条命。`,
    });
  }
  return pump(state, effects);
}

function advanceExchange(state: CoupState, effects: CoupEffect[]): void {
  const pending = state.pendingExchange;
  if (!pending) return finishGame(state, effects, null, "no_pending_exchange");
  const seat = state.seats[pending.seat];
  const submission = state.pending[pending.seat];
  const move = submission?.status === "ready" ? submission.move : null;
  if (!move || move.kind !== "exchange") {
    emit(effects, "coup.forfeit", {
      turn: state.turn,
      seat: pending.seat,
      phase: "exchange_pick",
      anomalies: submission?.anomalies?.length ? submission.anomalies : ["no_exchange"],
    });
  }
  const keepIds = move && move.kind === "exchange" ? move.keep : [];

  const pool = [...seat.cards, ...pending.drawn];
  const keep = pool.filter((c) => keepIds.includes(c.id));
  const returned = pool.filter((c) => !keepIds.includes(c.id));
  const wanted = seat.cards.length;

  // Defensive: a bad `keep` must not change the hand size.
  let finalKeep = keep;
  if (finalKeep.length !== wanted) {
    finalKeep = pool.slice(0, wanted);
  }
  const finalReturn = pool.filter((c) => !finalKeep.some((k) => k.id === c.id));

  seat.cards = finalKeep;
  state.deck = shuffle([...state.deck, ...finalReturn], state.seed, `coup:exchange:${state.turn}:${pending.seat}`);
  state.pendingExchange = null;
  state.script.shift();

  emit(effects, "coup.exchange", {
    turn: state.turn,
    seat: pending.seat,
    kept: finalKeep.map((c) => c.role),
    deck: state.deck.length,
  });
  log(state, {
    turn: state.turn,
    kind: "system",
    seat: pending.seat,
    text: `${seatTag(pending.seat)} 换牌：留 ${finalKeep.map((c) => roleName(state, c.role)).join("、")}。`,
  });
  return pump(state, effects);
}

/* ── the script machine ────────────────────────────────────────────── */

function pump(state: CoupState, effects: CoupEffect[]): void {
  while (state.script.length > 0) {
    const step = state.script[0];

    if (step.kind === "lose") {
      const seat = state.seats[step.seat];
      if (!seat || !seat.alive) {
        state.script.shift();
        continue;
      }
      // Only ask when there is an actual choice; one card flips itself.
      if (seat.cards.length > 1) {
        state.pendingFlip = { seat: step.seat, cause: step.cause };
        enterPhase(state, effects, "influence_lose", [step.seat], "sequential");
        return;
      }
      const card = applyLose(state, step.seat, step.cause, 0);
      state.script.shift();
      if (card) {
        emit(effects, "coup.lost", {
          turn: state.turn,
          seat: step.seat,
          role: card.role,
          cause: step.cause,
          remaining: state.seats[step.seat].cards.length,
        });
        log(state, {
          turn: state.turn,
          kind: "lost",
          seat: step.seat,
          text: `${seatTag(step.seat)} 翻开${roleName(state, card.role)}，剩 ${state.seats[step.seat].cards.length} 条命。`,
        });
      }
      continue;
    }

    if (step.kind === "exchange") {
      const drawn = draw(state, 2);
      const seat = state.seats[step.seat];
      if (drawn.length === 0) {
        state.script.shift();
        continue;
      }
      // No real choice: returning everything to the deck is the only move.
      if (seat.cards.length + drawn.length <= 1) {
        state.deck = shuffle([...state.deck, ...drawn], state.seed, `coup:exchange:${state.turn}:${step.seat}`);
        state.script.shift();
        continue;
      }
      state.pendingExchange = { seat: step.seat, drawn };
      enterPhase(state, effects, "exchange_pick", [step.seat], "sequential");
      return;
    }

    applyStep(state, step, effects);
    state.script.shift();
  }

  if (state.resume === "block_window") {
    state.resume = null;
    return openBlockWindow(state, effects);
  }
  if (state.resume === "effect") {
    state.resume = null;
    const claim = state.claim;
    if (claim && !state.script.length) {
      state.script.push(...effectSteps(state, claim));
      return pump(state, effects);
    }
  }
  advanceTurn(state, effects);
}

function applyStep(state: CoupState, step: CoupStep, effects: CoupEffect[]): void {
  switch (step.kind) {
    case "gain": {
      const seat = state.seats[step.seat];
      if (!seat) return;
      const before = seat.coins;
      seat.coins += step.coins;
      emitCoins(state, effects, [{ seat: step.seat, before }]);
      return;
    }
    case "pay": {
      const seat = state.seats[step.seat];
      if (!seat) return;
      const before = seat.coins;
      seat.coins = Math.max(0, seat.coins - step.coins);
      emitCoins(state, effects, [{ seat: step.seat, before }]);
      return;
    }
    case "refund": {
      const seat = state.seats[step.seat];
      if (!seat) return;
      const before = seat.coins;
      seat.coins += step.coins;
      emitCoins(state, effects, [{ seat: step.seat, before }]);
      return;
    }
    case "transfer": {
      const from = state.seats[step.from];
      const to = state.seats[step.to];
      if (!from || !to) return;
      const amount = Math.min(step.coins, from.coins);
      const beforeFrom = from.coins;
      const beforeTo = to.coins;
      from.coins -= amount;
      to.coins += amount;
      emitCoins(state, effects, [
        { seat: step.from, before: beforeFrom },
        { seat: step.to, before: beforeTo },
      ]);
      return;
    }
    case "prove": {
      applyProve(state, step.seat, step.role);
      const seat = state.seats[step.seat];
      if (seat) {
        emit(effects, "coup.hand", { turn: state.turn, seat: step.seat, cards: seat.cards });
      }
      return;
    }
    case "void": {
      if (step.reason === "challenge") {
        state.claim = null;
      }
      emit(effects, "coup.result", {
        turn: state.turn,
        voided: step.reason,
      });
      return;
    }
    default:
      return;
  }
}

function effectSteps(state: CoupState, claim: CoupClaim): CoupStep[] {
  const { rules } = state.spec;
  switch (claim.action) {
    case "income":
      return [{ kind: "gain", seat: claim.seat, coins: 1 }];
    case "foreign_aid":
      return [{ kind: "gain", seat: claim.seat, coins: 2 }];
    case "coup":
      return [{ kind: "lose", seat: claim.target!, cause: "coup" }];
    case "tax":
      return [{ kind: "gain", seat: claim.seat, coins: 3 }];
    case "assassinate":
      return [{ kind: "lose", seat: claim.target!, cause: "assassinated" }];
    case "steal": {
      const target = state.seats[claim.target!];
      const amount = Math.min(rules.stealCap, target?.coins ?? 0);
      return [{ kind: "transfer", from: claim.target!, to: claim.seat, coins: amount }];
    }
    case "exchange":
      return [{ kind: "exchange", seat: claim.seat }];
    default:
      return [];
  }
}

/* ── turn end & win ────────────────────────────────────────────────── */

function advanceTurn(state: CoupState, effects: CoupEffect[]): void {
  state.claim = null;
  state.reactions = [];
  state.blocker = null;
  state.blockReactions = [];
  state.pendingFlip = null;
  state.pendingExchange = null;

  if (checkEnd(state, effects)) return;

  state.turn += 1;
  if (state.turn > state.spec.rules.maxTurns) {
    return settleByScore(state, effects);
  }
  beginTurn(state, effects);
}

function checkEnd(state: CoupState, effects: CoupEffect[]): boolean {
  const alive = aliveSeats(state);
  if (alive.length === 1) {
    finishGame(state, effects, alive[0], "last_standing");
    return true;
  }
  if (alive.length === 0) {
    finishGame(state, effects, null, "all_eliminated");
    return true;
  }
  return false;
}

function settleByScore(state: CoupState, effects: CoupEffect[]): void {
  const alive = state.seats.filter((s) => s.alive);
  const ranked = [...alive].sort((a, b) => b.cards.length - a.cards.length || b.coins - a.coins);
  const top = ranked[0];
  const second = ranked[1];
  if (!top) return finishGame(state, effects, null, "turn_limit");
  const tie = second && second.cards.length === top.cards.length && second.coins === top.coins;
  finishGame(state, effects, tie ? null : top.seat, tie ? "turn_limit_tie" : "turn_limit");
}

function finishGame(state: CoupState, effects: CoupEffect[], winner: number | null, reason: string): void {
  if (state.phase === "done") return;
  state.phase = "done";
  state.winner = winner;
  state.endReason = reason;
  state.actor = null;
  emit(effects, "coup.finished", {
    winner,
    reason,
    turns: state.turn,
    influence: state.seats.map((s) => ({ seat: s.seat, left: s.cards.length, coins: s.coins })),
    coins: state.seats.map((s) => ({ seat: s.seat, coins: s.coins })),
  });
  effects.push({ kind: "finish", winner, reason });
}

/* ── primitives ────────────────────────────────────────────────────── */

function applyLose(state: CoupState, seatIndex: number, cause: LossCause, index: number): CoupCard | null {
  const seat = state.seats[seatIndex];
  if (!seat || seat.cards.length === 0) return null;
  const i = Math.min(Math.max(index, 0), seat.cards.length - 1);
  const [card] = seat.cards.splice(i, 1);
  seat.revealed.push({ ...card, turn: state.turn, cause });
  if (seat.cards.length === 0) seat.alive = false;
  return card ?? null;
}

/**
 * Reveal, shuffle back, draw a replacement. The card goes back *before* the draw,
 * so the deck can never be empty at this point even if it was exhausted.
 */
function applyProve(state: CoupState, seatIndex: number, role: CoupRole): void {
  const seat = state.seats[seatIndex];
  if (!seat) return;
  const i = seat.cards.findIndex((c) => c.role === role);
  if (i < 0) return;
  const [card] = seat.cards.splice(i, 1);
  state.deck = shuffle([...state.deck, card], state.seed, `coup:return:${state.turn}:${seatIndex}`);
  const replacement = state.deck.shift();
  if (replacement) seat.cards.push(replacement);
}

function draw(state: CoupState, n: number): CoupCard[] {
  return state.deck.splice(0, n);
}

function collectReactions(state: CoupState): CoupReaction[] {
  const out: CoupReaction[] = [];
  for (const seat of state.queue) {
    const submission = state.pending[seat];
    if (!submission || submission.status !== "ready" || !submission.move) {
      out.push({
        seat,
        kind: "pass",
        as: null,
        say: "",
        note: clip(submission?.thinking ?? "", 300),
        forfeit: true,
        anomalies: submission?.anomalies?.length ? submission.anomalies : ["no_reaction"],
      });
      continue;
    }
    const move = submission.move;
    if (move.kind !== "react") {
      out.push({
        seat,
        kind: "pass",
        as: null,
        say: "",
        note: clip(submission.thinking ?? "", 300),
        forfeit: true,
        anomalies: ["invalid_reaction"],
      });
      continue;
    }
    // A block is only legal for the roles and scope the action allows; anything
    // else degrades to a pass rather than becoming a phantom blocker.
    if (move.reaction === "block") {
      const allowed: { blockRoles: CoupRole[] } =
        state.phase === "action_reaction" ? legalReactions(state, seat) : { blockRoles: [] };
      if (!move.as || !allowed.blockRoles.includes(move.as)) {
        out.push({
          seat,
          kind: "pass",
          as: null,
          say: "",
          note: clip(submission.thinking ?? "", 300),
          forfeit: true,
          anomalies: ["invalid_block"],
        });
        continue;
      }
    }
    out.push({
      seat,
      kind: move.reaction,
      as: move.reaction === "block" ? move.as : null,
      say: clip(move.say, 200),
      note: clip(submission.thinking ?? "", 300),
      forfeit: false,
      anomalies: [],
    });
  }
  return out;
}

/** First seat clockwise from `from` (exclusive) that appears in `candidates`. */
function firstClockwise(state: CoupState, from: number, candidates: CoupReaction[]): CoupReaction | null {
  if (candidates.length === 0) return null;
  const bySeat = new Map(candidates.map((c) => [c.seat, c]));
  for (let step = 1; step <= state.seats.length; step++) {
    const seat = (from + step) % state.seats.length;
    const hit = bySeat.get(seat);
    if (hit) return hit;
  }
  return candidates[0] ?? null;
}

function aliveSeats(state: CoupState): number[] {
  return state.seats.filter((s) => s.alive).map((s) => s.seat);
}

function enterPhase(
  state: CoupState,
  effects: CoupEffect[],
  phase: CoupPhase,
  seats: number[],
  mode: "sequential" | "parallel",
): void {
  state.phase = phase;
  state.queue = [...seats];
  state.callMode = mode;
  state.queueIndex = mode === "parallel" ? seats.length : 0;
  state.pending = {};
  state.recalled = [];
  for (const seat of seats) {
    effects.push({ kind: "call_seat", seat, phase });
    if (mode === "sequential") state.queueIndex += 1;
  }
  emit(effects, "phase.changed", { phase, queue: seats, mode });
}

/* ── legality ──────────────────────────────────────────────────────── */

export function legalAction(
  state: CoupState,
  seatIndex: number,
  action: CoupActionKind,
): Extract<CoupMove, { kind: "act" }> | null {
  const seat = state.seats[seatIndex];
  if (!seat || !seat.alive) return null;
  const { rules } = state.spec;
  const forced = seat.coins >= rules.forcedCoupAt;

  if (forced && action !== "coup") return null;
  if (action === "coup" && seat.coins < rules.coupCost) return null;
  if (action === "assassinate" && seat.coins < rules.assassinateCost) return null;
  if (!ROLE_ACTIONS[action] && action !== "income" && action !== "foreign_aid" && action !== "coup") {
    // steal / exchange have a role; nothing to reject here beyond the role claim itself.
  }

  let target: number | null = null;
  if (action === "steal" || action === "assassinate" || action === "coup") {
    const candidates = state.seats.filter((s) => s.alive && s.seat !== seatIndex).map((s) => s.seat);
    target = candidates[0] ?? null;
    if (target === null) return null;
  }
  return { kind: "act", action, target, say: "" };
}

export function legalReactions(state: CoupState, seatIndex: number): {
  reactions: Array<"pass" | "challenge" | "block">;
  blockRoles: CoupRole[];
} {
  const claim = state.claim;
  if (!claim) return { reactions: ["pass"], blockRoles: [] };
  const seat = state.seats[seatIndex];
  if (!seat || !seat.alive) return { reactions: ["pass"], blockRoles: [] };

  const out: Array<"pass" | "challenge" | "block"> = ["pass"];
  if (claim.role) out.push("challenge");

  const blocker = BLOCKERS[claim.action];
  if (blocker) {
    const allowed = blocker.scope === "anyone" || claim.target === seatIndex;
    if (allowed) out.push("block");
    return { reactions: out, blockRoles: allowed ? blocker.roles : [] };
  }
  return { reactions: out, blockRoles: [] };
}

/* ── view ──────────────────────────────────────────────────────────── */

export function coupSeatView(state: CoupState, seatIndex: number): CoupSeatView {
  const seat = state.seats[seatIndex];
  const legal = legalReactions(state, seatIndex);
  const actor = state.actor;
  const forced = actor !== null && mustCoup(state, actor);

  const actions: CoupActionKind[] = [];
  if (state.phase === "action_select" && actor === seatIndex) {
    if (forced) actions.push("coup");
    else {
      actions.push("income", "foreign_aid", "exchange", "tax", "steal");
      if (seat.coins >= state.spec.rules.assassinateCost) actions.push("assassinate");
      if (seat.coins >= state.spec.rules.coupCost) actions.push("coup");
    }
  }

  return {
    seat,
    hand: seat.cards,
    revealed: seat.revealed.map((c) => ({ role: c.role, turn: c.turn })),
    coins: seat.coins,
    deckCount: state.deck.length,
    legal: {
      actions,
      targets: state.seats.filter((s) => s.alive && s.seat !== seatIndex).map((s) => s.seat),
      reactions: state.phase === "action_reaction" || state.phase === "block_reaction"
        ? legal.reactions
        : [],
      blockRoles: state.phase === "action_reaction" ? legal.blockRoles : [],
      forcedCoup: forced,
      claim: state.claim,
      flipCount: seat.cards.length,
    },
  };
}

/* ── coercion ──────────────────────────────────────────────────────── */

/** Turn a parsed JSON payload into a move the reducer can validate. */
/**
 * The prompt speaks 1-based seat numbers (1–4), the engine speaks 0-based
 * indices. `null`, `""` and `0` all mean "no target" — `Number(null)` is 0,
 * which used to turn every `"target": null` into seat 1 and reject the move.
 */
function seatTarget(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const index = Math.trunc(n) - 1;
  return index >= 0 ? index : null;
}

const ACTION_ALIAS: Record<string, CoupActionKind> = {
  收入: "income",
  外援: "foreign_aid",
  政变: "coup",
  征税: "tax",
  偷窃: "steal",
  刺杀: "assassinate",
  换牌: "exchange",
};

const REACTION_ALIAS: Record<string, "pass" | "challenge" | "block"> = {
  放过: "pass",
  过: "pass",
  弃权: "pass",
  质疑: "challenge",
  阻挡: "block",
};

const ROLE_ALIAS: Record<string, CoupRole> = {
  公爵: "duke",
  刺客: "assassin",
  队长: "captain",
  大使: "ambassador",
  伯爵夫人: "contessa",
};

export function coerceCoupMove(phase: CoupPhase, content: Record<string, unknown>): CoupMove | null {
  const say = typeof content.say === "string" ? content.say.trim().slice(0, 200) : "";

  if (phase === "action_select") {
    const raw = typeof content.action === "string" ? content.action.trim() : "";
    if (!raw) return null;
    const action = (ACTION_ALIAS[raw] ?? raw.toLowerCase()) as CoupActionKind;
    return {
      kind: "act",
      action,
      target: seatTarget(content.target),
      say,
    };
  }

  if (phase === "action_reaction" || phase === "block_reaction") {
    const raw = typeof content.reaction === "string" ? content.reaction.trim() : "pass";
    const reaction = REACTION_ALIAS[raw] ?? (raw.toLowerCase() as "pass" | "challenge" | "block");
    const rawAs = typeof content.as === "string" ? content.as.trim() : "";
    const as = rawAs ? ((ROLE_ALIAS[rawAs] ?? rawAs) as CoupRole) : null;
    return { kind: "react", reaction, as, say };
  }

  if (phase === "influence_lose") {
    const index = Number(content.flip);
    return { kind: "flip", index: Number.isFinite(index) ? index : 0 };
  }

  if (phase === "exchange_pick") {
    const keep = Array.isArray(content.keep) ? content.keep.filter((x): x is string => typeof x === "string") : [];
    return { kind: "exchange", keep };
  }

  return null;
}

/* ── recall / recover ──────────────────────────────────────────────── */

export function recallSeat(state: CoupState, seatIndex: number): CoupReduceResult {
  const effects: CoupEffect[] = [];
  if (state.phase === "done" || state.phase === "dealing") return { state, effects };
  const target = state.seats.find((s) => s.seat === seatIndex);
  if (!target) return { state, effects };
  if (target.lastForfeitPhase !== state.phase) return { state, effects };
  if (state.pending[seatIndex] === undefined) return { state, effects };
  if (!state.queue.includes(seatIndex)) return { state, effects };
  if (state.recalled.includes(seatIndex)) return { state, effects };

  const next = clone(state);
  delete next.pending[seatIndex];
  const seat = next.seats.find((s) => s.seat === seatIndex)!;
  seat.forfeitsInARow = Math.max(0, seat.forfeitsInARow - 1);
  seat.lastForfeitPhase = null;
  next.recalled.push(seatIndex);
  effects.push({ kind: "call_seat", seat: seatIndex, phase: next.phase });
  return { state: next, effects };
}

export function recoverCoup(state: CoupState): CoupReduceResult {
  const next = clone(state);
  const effects: CoupEffect[] = [];
  if (next.phase === "done" || next.phase === "dealing") return { state: next, effects };

  const owed = next.queue.filter((seat) => next.pending[seat] === undefined);
  if (owed.length === 0) {
    advance(next, effects);
    return { state: next, effects };
  }

  const calls = next.callMode === "parallel" ? owed : [owed[0]];
  for (const seat of calls) {
    effects.push({ kind: "call_seat", seat, phase: next.phase });
  }
  const head = next.queue.indexOf(calls[0]);
  if (head >= next.queueIndex) next.queueIndex = head + 1;
  return { state: next, effects };
}

/* ── helpers ───────────────────────────────────────────────────────── */

function emit(
  effects: CoupEffect[],
  type: string,
  payload: Record<string, unknown>,
  seat?: number,
): void {
  effects.push({
    kind: "emit",
    event: {
      type: type as ArenaEvent["type"],
      ts: Date.now(),
      ...(seat !== undefined ? { seat } : {}),
      payload,
    },
  });
}

/** One event per balance change; the audience never has to infer coins. */
function emitCoins(
  state: CoupState,
  effects: CoupEffect[],
  changed: Array<{ seat: number; before: number }>,
): void {
  const rows = changed
    .map(({ seat, before }) => {
      const s = state.seats[seat];
      return s ? { seat: s.seat, coins: s.coins, before } : null;
    })
    .filter((r): r is { seat: number; coins: number; before: number } => r !== null);
  if (rows.length > 0) emit(effects, "coup.coins", { turn: state.turn, coins: rows });
}

function log(state: CoupState, entry: CoupLogEntry): void {
  state.publicLog.push({ ...entry, text: clip(entry.text, 40) });
}

function seatTag(seat: number): string {
  return `${seat + 1} 号`;
}

function roleName(state: CoupState, role: CoupRole): string {
  return state.spec.roles.find((r) => r.id === role)?.label ?? role;
}

function costOf(state: CoupState, action: CoupActionKind): number {
  if (action === "assassinate") return state.spec.rules.assassinateCost;
  if (action === "coup") return state.spec.rules.coupCost;
  return 0;
}

function actionName(action: CoupActionKind): string {
  switch (action) {
    case "income":
      return "收入";
    case "foreign_aid":
      return "外援";
    case "coup":
      return "政变";
    case "tax":
      return "征税";
    case "steal":
      return "偷窃";
    case "assassinate":
      return "刺杀";
    case "exchange":
      return "换牌";
  }
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clone(state: CoupState): CoupState {
  return structuredClone(state);
}
