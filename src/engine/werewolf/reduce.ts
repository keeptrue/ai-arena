/**
 * Nine-seat werewolf reducer. Pure: (state, action) -> (state, effects).
 *
 * The engine owns every fact: who dies, what the seer sees, how a tie breaks.
 * Models only choose actions; the judge model never narrates a death.
 */

import { roll } from "../rng";
import type { ArenaEvent } from "../types";
import { campOfRole, isGod } from "./blueprint";
import { salvageSpeech } from "./speech";
import type {
  DeathCause,
  PhaseAction,
  PublicEntry,
  WerewolfAction,
  WerewolfBlueprint,
  WerewolfCamp,
  WerewolfDealMode,
  WerewolfEffect,
  WerewolfPhase,
  WerewolfReduceResult,
  WerewolfSeatState,
  WerewolfState,
  WerewolfSubmission,
} from "./types";

/* ── construction ──────────────────────────────────────────────────── */

export interface WerewolfSeatInput {
  participantId: string;
  seat: number;
  role: WerewolfSeatState["role"];
}

export function createWerewolfState(input: {
  matchId: string;
  spec: WerewolfBlueprint;
  seed: string;
  dealSource: WerewolfDealMode | "engine_fallback";
  seats: WerewolfSeatInput[];
  budget: { maxCalls: number; maxTokens: number };
  at: number;
}): WerewolfState {
  return {
    matchId: input.matchId,
    spec: input.spec,
    seed: input.seed,
    dealSource: input.dealSource,
    seats: input.seats.map((s) => ({
      participantId: s.participantId,
      seat: s.seat,
      role: s.role,
      camp: campOfRole(s.role),
      alive: true,
      death: null,
      lastWords: null,
      afk: false,
      forfeitsInARow: 0,
      lastForfeitPhase: null,
    })),
    day: 0,
    phase: "dealing",
    night: emptyNight(),
    potions: { antidote: input.spec.rules.witch.antidote, poison: input.spec.rules.witch.poison },
    checks: [],
    votes: {},
    pk: null,
    pending: {},
    queue: [],
    recalled: [],
    queueIndex: 0,
    callMode: "sequential",
    publicLog: [],
    lastSpeaker: null,
    deathsTonight: [],
    deathsToday: [],
    wordsQueue: [],
    wordsNext: "night",
    hunterTrigger: null,
    selfDestruct: null,
    winner: null,
    endReason: null,
    startedAt: input.at,
    budget: { ...input.budget, calls: 0, tokens: 0 },
  };
}

function emptyNight(): WerewolfState["night"] {
  return {
    wolfStage: "discuss",
    wolfVotes: {},
    wolfTalk: [],
    killTarget: null,
    saved: false,
    poisonTarget: null,
    seerTarget: null,
    seerResult: null,
  };
}

function clone(state: WerewolfState): WerewolfState {
  return {
    ...state,
    seats: state.seats.map((s) => ({ ...s })),
    night: { ...state.night, wolfVotes: { ...state.night.wolfVotes }, wolfTalk: [...state.night.wolfTalk] },
    potions: { ...state.potions },
    checks: state.checks.map((c) => ({ ...c })),
    votes: { ...state.votes },
    pk: state.pk ? { candidates: [...state.pk.candidates], votes: { ...state.pk.votes } } : null,
    pending: { ...state.pending },
    queue: [...state.queue],
    // `?? []` keeps a checkpoint written before manual recall resumable.
    recalled: [...(state.recalled ?? [])],
    publicLog: [...state.publicLog],
    deathsTonight: [...state.deathsTonight],
    deathsToday: [...state.deathsToday],
    wordsQueue: [...state.wordsQueue],
    budget: { ...state.budget },
  };
}

/* ── reducer ───────────────────────────────────────────────────────── */

export function reduceWerewolf(state: WerewolfState, action: WerewolfAction): WerewolfReduceResult {
  if (action.kind === "abort") {
    const next = clone(state);
    const effects: WerewolfEffect[] = [];
    finishGame(next, effects, null, `aborted:${action.reason}`);
    return { state: next, effects };
  }
  if (action.kind === "start") {
    if (state.phase !== "dealing") return { state, effects: [] };
    const next = clone(state);
    const effects: WerewolfEffect[] = [];
    start(next, effects, action.at);
    return { state: next, effects };
  }
  if (state.phase === "done" || state.phase === "dealing") return { state, effects: [] };
  if (action.kind === "recall") return recallSeat(state, action.seat);
  return submit(state, action.submission);
}

/* ── manual recall ─────────────────────────────────────────────────── */

/**
 * Re-open one seat's turn after a cut that produced no usable answer.
 *
 * A surface timeout and a dead provider look identical from the outside, so a
 * false one must not decide the table. The seat's provisional action is dropped,
 * the strike it earned is refunded (which also un-AFKs it), and it is allowed to
 * answer late for the rest of this phase.
 *
 * Legal only while the phase it failed in is still open: once the engine has
 * resolved the night or closed the vote, re-opening a seat would rewind a fact.
 */
export function recallSeat(state: WerewolfState, seat: number): WerewolfReduceResult {
  const effects: WerewolfEffect[] = [];
  if (state.phase === "done" || state.phase === "dealing") return { state, effects: [] };
  const target = state.seats.find((s) => s.seat === seat);
  if (!target) return { state, effects: [] };
  if (target.lastForfeitPhase !== state.phase) return { state, effects: [] };
  if (state.pending[seat] === undefined) return { state, effects: [] };
  // Not in this phase's queue (AFK seats are filtered out of queues): a call here
  // could never be accepted, it would just stall the table.
  if (!state.queue.includes(seat)) return { state, effects: [] };
  if (state.recalled.includes(seat)) return { state, effects: [] };

  const next = clone(state);
  const seatState = next.seats.find((s) => s.seat === seat)!;
  delete next.pending[seat];
  seatState.forfeitsInARow = Math.max(0, seatState.forfeitsInARow - 1);
  seatState.afk = false;
  seatState.lastForfeitPhase = null;
  next.recalled.push(seat);

  emit(effects, "seat.recalled", { phase: next.phase, reason: "manual" }, seat);
  // A fresh call: the dead attempt's window is long gone.
  effects.push({ kind: "call_seat", seat, phase: next.phase, stage: callStage(next, next.phase) });
  return { state: next, effects };
}

/* ── crash recovery ────────────────────────────────────────────────── */

/**
 * Pick a match back up after the process died mid-phase.
 *
 * The state already records who acted (`pending`) and who was called
 * (`queueIndex`), so recovery is exactly one thing: re-issue the calls the current
 * phase still owes, and mark each of them so the audience loses the half-written
 * thought from the dead run. A seat that already answered is never called twice.
 */
export function recoverWerewolf(state: WerewolfState): WerewolfReduceResult {
  const next = clone(state);
  const effects: WerewolfEffect[] = [];
  if (next.phase === "done" || next.phase === "dealing") return { state: next, effects };

  const owed = next.queue.filter((seat) => next.pending[seat] === undefined);
  if (owed.length === 0) {
    // Everything this phase asked for is in: let the machine walk on.
    advance(next, effects);
    return { state: next, effects };
  }

  const calls = next.callMode === "parallel" ? owed : [owed[0]];
  for (const seat of calls) {
    emit(effects, "seat.recalled", { phase: next.phase, reason: "recover" }, seat);
    effects.push({ kind: "call_seat", seat, phase: next.phase, stage: callStage(next, next.phase) });
  }
  // Invariant: `queueIndex` points past the last call that was issued. Without this
  // the seat's own submission would let `advance` call it a second time.
  const head = next.queue.indexOf(calls[0]);
  if (head >= next.queueIndex) next.queueIndex = head + 1;
  return { state: next, effects };
}

function start(next: WerewolfState, effects: WerewolfEffect[], at: number): void {
  next.day = 1;
  next.startedAt = at;
  next.phase = "dealing";
  emit(effects, "match.created", {
    matchId: next.matchId,
    kind: "werewolf",
    name: next.spec.name,
    tagline: next.spec.tagline,
    briefing: next.spec.briefing,
    maxDays: next.spec.rules.maxDays,
    roles: next.spec.roles,
    seats: next.seats.map((s) => ({ participantId: s.participantId, seat: s.seat })),
  });
  emit(effects, "roles.dealt", {
    source: next.dealSource,
    seats: next.seats.map((s) => ({ seat: s.seat, role: s.role, camp: s.camp })),
  });
  emit(effects, "round.opened", { day: next.day, phase: "night_wolves", maxDays: next.spec.rules.maxDays });
  enterPhase(next, effects, "night_wolves", wolves(next), "sequential");
  advance(next, effects);
}

/* ── submissions ───────────────────────────────────────────────────── */

function submit(state: WerewolfState, submission: WerewolfSubmission): WerewolfReduceResult {
  const next = clone(state);
  const effects: WerewolfEffect[] = [];
  const phase = next.phase;
  if (submission.phase !== phase) return { state, effects: [] };

  const inTurn =
    next.callMode === "parallel"
      ? next.queue.includes(submission.seat)
      : next.queue[next.queueIndex - 1] === submission.seat;
  // A seat re-opened by hand already had its turn. Its late answer still counts, and
  // this is the only way to undo a false cut without rewinding `queueIndex` — which
  // would re-call whoever came after it.
  const lateButLegal =
    next.recalled.includes(submission.seat) && next.queue.includes(submission.seat);
  if ((!inTurn && !lateButLegal) || next.pending[submission.seat] !== undefined) {
    return { state, effects: [] };
  }

  const seat = next.seats.find((s) => s.seat === submission.seat);
  if (!seat) return { state, effects: [] };

  const priorVote =
    phase === "night_wolves" && (next.night.wolfStage ?? "discuss") === "decide"
      ? next.night.wolfVotes[seat.seat]
      : undefined;
  let action = submission.status === "ready" ? validateAction(next, seat, submission.action) : null;
  let failed = submission.status === "forfeit" || action === null;
  if (submission.status === "ready" && action === null) {
    emit(
      effects,
      "anomaly",
      {
        code: "invalid_action",
        message: `${submission.seat + 1} 号提交不合法，${
          priorVote !== undefined ? "沿用第一轮提议" : "按弃权处理"
        }`,
      },
      submission.seat,
    );
  }
  if (action === null) action = defaultAction(next, seat);
  // A failed deciding call still carries the wolf's own first-round proposal. Reusing
  // it is not a fabricated vote, and it keeps one empty answer from tilting the knife.
  if (failed && priorVote !== undefined) {
    action = {
      kind: "wolf",
      target: priorVote,
      talk: clamp(submission.action?.kind === "wolf" ? submission.action.talk : "", 200),
    };
  }

  if (failed) {
    seat.forfeitsInARow += 1;
    seat.lastForfeitPhase = phase;
    emit(
      effects,
      "seat.forfeit",
      { phase, reason: submission.anomalies[0] ?? "invalid_action", seat: seat.seat },
      seat.seat,
    );
    if (seat.forfeitsInARow >= 2 && !seat.afk) {
      seat.afk = true;
      emit(effects, "seat.afk", { seat: seat.seat }, seat.seat);
    }
  } else {
    seat.forfeitsInARow = 0;
    seat.lastForfeitPhase = null;
    next.recalled = next.recalled.filter((s) => s !== seat.seat);
    emit(effects, "seat.submitted", {
      phase,
      content: action,
      thinking: submission.thinking,
      reasoning: submission.reasoning,
    }, seat.seat);
  }

  next.pending[seat.seat] = action;
  if (action.kind === "wolf" && action.talk.trim()) {
    const text = action.talk.trim().slice(0, 200);
    next.night.wolfTalk.push({ seat: seat.seat, text });
    emit(effects, "wolf.chat", { day: next.day, seat: seat.seat, text }, seat.seat);
  }
  if ((phase === "day_speech" || phase === "day_pk_speech") && action.kind === "speech") {
    handleSpeech(next, effects, seat.seat);
  }
  if (phase === "day_last_words" && action.kind === "last_words") {
    speakLastWords(next, effects, seat.seat);
    next.wordsQueue = next.wordsQueue.filter((s) => s !== seat.seat);
  }
  next.budget.calls += 1;
  next.budget.tokens += submission.usage.promptTokens + submission.usage.completionTokens;
  next.budget.cachedTokens = (next.budget.cachedTokens ?? 0) + (submission.usage.cachedPromptTokens ?? 0);
  next.budget.cacheWriteTokens =
    (next.budget.cacheWriteTokens ?? 0) + (submission.usage.cacheWriteTokens ?? 0);

  advance(next, effects);
  return { state: next, effects };
}

function validateAction(
  state: WerewolfState,
  seat: WerewolfSeatState,
  raw: PhaseAction | null,
): PhaseAction | null {
  if (!raw) return null;
  const alive = state.seats.filter((s) => s.alive);
  const aliveSeats = new Set(alive.map((s) => s.seat));
  switch (state.phase) {
    case "night_wolves": {
      if (raw.kind !== "wolf" || seat.role !== "wolf") return null;
      if (!state.spec.rules.wolf.allowEmptyKill && raw.target === "empty") return null;
      if (raw.target !== "empty") {
        if (!aliveSeats.has(raw.target)) return null;
        const target = state.seats.find((s) => s.seat === raw.target);
        if (target?.camp === "wolf" && !state.spec.rules.wolf.allowSelfKill) return null;
      }
      return { kind: "wolf", target: raw.target, talk: clamp(raw.talk, 200) };
    }
    case "night_seer": {
      if (raw.kind !== "seer" || seat.role !== "seer") return null;
      if (!aliveSeats.has(raw.target) || raw.target === seat.seat) return null;
      return { kind: "seer", target: raw.target };
    }
    case "night_witch": {
      if (raw.kind !== "witch" || seat.role !== "witch") return null;
      if (raw.action === "none") return { kind: "witch", action: "none", target: null };
      if (raw.action === "save") {
        if (state.potions.antidote <= 0 || state.night.killTarget === null) return null;
        if (state.night.killTarget === seat.seat && !selfSaveAllowed(state)) return null;
        return { kind: "witch", action: "save", target: null };
      }
      if (raw.action === "poison") {
        if (state.potions.poison <= 0) return null;
        if (raw.target === null || raw.target === undefined) return null;
        if (!aliveSeats.has(raw.target)) return null;
        if (raw.target === seat.seat && !state.spec.rules.witch.poisonSelf) return null;
        return { kind: "witch", action: "poison", target: raw.target };
      }
      return null;
    }
    case "hunter_shot": {
      if (raw.kind !== "hunter" || seat.role !== "hunter") return null;
      if (raw.target === "pass") return { kind: "hunter", target: "pass" };
      if (!aliveSeats.has(raw.target) || raw.target === seat.seat) return null;
      return { kind: "hunter", target: raw.target };
    }
    case "day_speech":
    case "day_pk_speech": {
      if (raw.kind !== "speech") return null;
      const text = clamp(raw.text, 1200).trim();
      if (!text) return null;
      const selfDestruct = raw.selfDestruct === true && seat.role === "wolf";
      return { kind: "speech", text, ...(selfDestruct ? { selfDestruct: true } : {}) };
    }    case "day_vote": {
      if (raw.kind !== "vote") return null;
      if (raw.target === "abstain") return { kind: "vote", target: "abstain" };
      if (!aliveSeats.has(raw.target) || raw.target === seat.seat) return null;
      return { kind: "vote", target: raw.target };
    }
    case "day_pk_vote": {
      if (raw.kind !== "vote") return null;
      if (raw.target === "abstain") return { kind: "vote", target: "abstain" };
      const candidates = state.pk?.candidates ?? [];
      if (!candidates.includes(raw.target)) return null;
      return { kind: "vote", target: raw.target };
    }
    case "day_last_words": {
      if (raw.kind !== "last_words") return null;
      return { kind: "last_words", text: clamp(raw.text, 800) };
    }
    default:
      return null;
  }
}

function selfSaveAllowed(state: WerewolfState): boolean {
  const mode = state.spec.rules.witch.selfSave;
  return mode === "always" || (mode === "first_night" && state.day === 1);
}

function defaultAction(state: WerewolfState, seat: WerewolfSeatState): PhaseAction {
  switch (state.phase) {
    case "night_wolves":
      return { kind: "wolf", target: "empty", talk: "" };
    case "night_seer":
      return { kind: "seer", target: seat.seat };
    case "night_witch":
      return { kind: "witch", action: "none", target: null };
    case "hunter_shot":
      return { kind: "hunter", target: "pass" };
    case "day_vote":
    case "day_pk_vote":
      return { kind: "vote", target: "abstain" };
    case "day_last_words":
      return { kind: "last_words", text: "" };
    default:
      return { kind: "speech", text: "（过麦）" };
  }
}

/* ── phase machine ─────────────────────────────────────────────────── */

function advance(state: WerewolfState, effects: WerewolfEffect[]): void {
  for (let guard = 0; guard < 200; guard++) {
    switch (state.phase) {
      case "night_wolves": {
        if (state.queue.length === 0) {
          toSeer(state, effects);
          continue;
        }
        if (state.queueIndex < state.queue.length) {
          callNext(state, effects);
          return;
        }
        if (Object.keys(state.pending).length < state.queue.length) return;
        {
          const deciding = (state.night.wolfStage ?? "discuss") === "decide";
          recordWolfVotes(state, deciding);
          const alive = wolves(state);
          if (!deciding && alive.length > 1) {
            // Same phase, second call set: the first round is a proposal, the second
            // is the knife. No `phase.changed` — the table is still in the wolf night.
            state.night.wolfStage = "decide";
            state.pending = {};
            state.recalled = [];
            state.queue = alive;
            state.queueIndex = 0;
            continue;
          }
          resolveWolves(state);
        }
        toSeer(state, effects);
        continue;
      }
      case "night_seer": {
        if (state.queue.length === 0) {
          toWitch(state, effects);
          continue;
        }
        if (state.queueIndex < state.queue.length) {
          callNext(state, effects);
          return;
        }
        if (Object.keys(state.pending).length < state.queue.length) return;
        resolveSeer(state, effects);
        toWitch(state, effects);
        continue;
      }
      case "night_witch": {
        if (state.queue.length === 0) {
          toDawn(state, effects);
          continue;
        }
        if (state.queueIndex < state.queue.length) {
          callNext(state, effects);
          return;
        }
        if (Object.keys(state.pending).length < state.queue.length) return;
        resolveWitch(state);
        toDawn(state, effects);
        continue;
      }
      case "dawn": {
        resolveDawn(state, effects);
        continue;
      }
      case "hunter_shot": {
        if (state.queue.length === 0) {
          resolveHunter(state, effects, null);
          continue;
        }
        if (state.queueIndex < state.queue.length) {
          callNext(state, effects);
          return;
        }
        if (Object.keys(state.pending).length < state.queue.length) return;
        const action = state.pending[state.queue[0]];
        resolveHunter(state, effects, action ?? null);
        continue;
      }
      case "day_last_words": {
        if (state.wordsQueue.length === 0) {
          afterWords(state, effects);
          continue;
        }
        if (state.queueIndex < state.queue.length) {
          callNext(state, effects);
          return;
        }
        if (Object.keys(state.pending).length < state.queue.length) return;
        // Every called word has been spoken; a leftover queue would be a bug, so
        // drain it rather than hang the match.
        afterWords(state, effects);
        continue;
      }
      case "day_speech": {
        if (state.queueIndex < state.queue.length) {
          callNext(state, effects);
          return;
        }
        if (Object.keys(state.pending).length < state.queue.length) return;
        enterPhase(state, effects, "day_vote", activeSeats(state), "parallel");
        continue;
      }
      case "day_vote": {
        if (Object.keys(state.pending).length < state.queue.length) return;
        resolveVote(state, effects);
        continue;
      }
      case "day_pk_speech": {
        if (state.queueIndex < state.queue.length) {
          callNext(state, effects);
          return;
        }
        if (Object.keys(state.pending).length < state.queue.length) return;
        const candidates = state.pk?.candidates ?? [];
        const voters = activeSeats(state).filter(
          (s) => state.spec.rules.day.pkVoters === "all" || !candidates.includes(s),
        );
        enterPhase(state, effects, "day_pk_vote", voters, "parallel");
        continue;
      }
      case "day_pk_vote": {
        if (Object.keys(state.pending).length < state.queue.length) return;
        resolvePkVote(state, effects);
        continue;
      }
      case "dealing":
      case "done":
        return;
    }
  }
  // A malformed state must never spin forever; surfacing a no-winner is safer than hanging.
  finishGame(state, effects, null, "phase_guard");
}

function callNext(state: WerewolfState, effects: WerewolfEffect[]): void {
  const seat = state.queue[state.queueIndex];
  if (seat === undefined) return;
  state.queueIndex += 1;
  effects.push({ kind: "call_seat", seat, phase: state.phase, stage: callStage(state, state.phase) });
}

/** The wolf night calls the same seat twice; the stage keeps those calls distinct. */
function callStage(
  state: WerewolfState,
  phase: WerewolfPhase,
): "discuss" | "decide" | undefined {
  return phase === "night_wolves" ? (state.night.wolfStage ?? "discuss") : undefined;
}

function enterPhase(
  state: WerewolfState,
  effects: WerewolfEffect[],
  phase: WerewolfPhase,
  seats: number[],
  mode: "sequential" | "parallel",
): void {
  state.phase = phase;
  state.callMode = mode;
  state.queue = [...seats];
  state.queueIndex = 0;
  state.pending = {};
  // A new phase never inherits last phase's late-answer passes.
  state.recalled = [];
  emit(effects, "phase.changed", { day: state.day, phase });
  if (mode === "parallel") {
    state.queueIndex = seats.length;
    const stage = callStage(state, phase);
    for (const seat of seats) effects.push({ kind: "call_seat", seat, phase, stage });
  }
}

/* ── night resolution ──────────────────────────────────────────────── */

function toSeer(state: WerewolfState, effects: WerewolfEffect[]): void {
  const seer = state.seats.find((s) => s.alive && s.role === "seer" && !s.afk);
  if (!seer) {
    toWitch(state, effects);
    return;
  }
  enterPhase(state, effects, "night_seer", [seer.seat], "sequential");
}

function toWitch(state: WerewolfState, effects: WerewolfEffect[]): void {
  const witch = state.seats.find((s) => s.alive && s.role === "witch" && !s.afk);
  if (!witch) {
    toDawn(state, effects);
    return;
  }
  enterPhase(state, effects, "night_witch", [witch.seat], "sequential");
}

function toDawn(state: WerewolfState, effects: WerewolfEffect[]): void {
  state.phase = "dawn";
  emit(effects, "phase.changed", { day: state.day, phase: "dawn" });
}

function recordWolfVotes(state: WerewolfState, deciding: boolean): void {
  // The deciding round starts from the first-round map: a wolf that went AFK after
  // speaking still has its own proposal counted, and every final answer overwrites it.
  const votes: Record<number, number | "empty"> = deciding ? { ...state.night.wolfVotes } : {};
  for (const [key, action] of Object.entries(state.pending)) {
    if (action?.kind === "wolf") votes[Number(key)] = action.target;
  }
  state.night.wolfVotes = votes;
}

function resolveWolves(state: WerewolfState): void {
  const votes = state.night.wolfVotes;
  const counts = new Map<string, number>();
  for (const value of Object.values(votes)) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  if (max === 0) {
    state.night.killTarget = null;
    return;
  }
  const top = [...counts.entries()]
    .filter(([, n]) => n === max)
    .map(([k]) => k)
    .sort();
  const pick =
    top.length === 1
      ? top[0]
      : top[Math.floor(roll(state.seed, state.day, 0, "wolf-tie") * top.length) % top.length];
  state.night.killTarget = pick === "empty" ? null : Number(pick);
}

function resolveSeer(state: WerewolfState, effects: WerewolfEffect[]): void {
  const seer = state.seats.find((s) => s.role === "seer");
  if (!seer) return;
  const action = state.pending[seer.seat];
  if (action?.kind !== "seer") return;
  const target = state.seats.find((s) => s.seat === action.target);
  if (!target || !target.alive || target.seat === seer.seat) return;
  const result = target.role === "wolf" ? "wolf" : "good";
  state.night.seerTarget = target.seat;
  state.night.seerResult = result;
  state.checks.push({ day: state.day, target: target.seat, result });
  emit(effects, "seer.check", { day: state.day, seat: seer.seat, target: target.seat, result }, seer.seat);
}

function resolveWitch(state: WerewolfState): void {
  const witch = state.seats.find((s) => s.role === "witch");
  if (!witch) return;
  const action = state.pending[witch.seat];
  if (action?.kind !== "witch") return;
  if (action.action === "save" && state.potions.antidote > 0 && state.night.killTarget !== null) {
    state.potions.antidote -= 1;
    state.night.saved = true;
  }
  if (action.action === "poison" && state.potions.poison > 0 && action.target !== null) {
    state.potions.poison -= 1;
    state.night.poisonTarget = action.target;
  }
}

function resolveDawn(state: WerewolfState, effects: WerewolfEffect[]): void {
  const causes = new Map<number, DeathCause>();
  if (state.night.killTarget !== null && !state.night.saved) causes.set(state.night.killTarget, "wolf");
  if (state.night.poisonTarget !== null) causes.set(state.night.poisonTarget, "poison");

  const deaths = [...causes.keys()].sort((a, b) => a - b);
  for (const seat of deaths) {
    const target = state.seats.find((s) => s.seat === seat);
    if (!target || !target.alive) {
      causes.delete(seat);
      continue;
    }
    target.alive = false;
    target.death = { day: state.day, cause: causes.get(seat)! };
    state.deathsTonight.push(seat);
    emit(effects, "seat.died", { seat, cause: causes.get(seat), day: state.day }, seat);
  }
  const finalDeaths = deaths.filter((seat) => !state.seats.find((s) => s.seat === seat)?.alive);
  state.deathsTonight = [...new Set([...state.deathsTonight, ...finalDeaths])];

  emit(effects, "night.resolved", {
    day: state.day,
    killTarget: state.night.killTarget,
    saved: state.night.saved,
    poisonTarget: state.night.poisonTarget,
    deaths: finalDeaths.map((seat) => ({ seat, cause: causes.get(seat) ?? "wolf" })),
  });
  emit(effects, "dawn", { day: state.day, deaths: finalDeaths });
  state.publicLog.push({ kind: "dawn", day: state.day, deaths: finalDeaths });

  const hunter = state.seats.find(
    (s) =>
      finalDeaths.includes(s.seat) &&
      s.role === "hunter" &&
      causes.get(s.seat) === "wolf" &&
      state.spec.rules.hunter.shootOn.includes("wolf"),
  );
  if (hunter) {
    state.hunterTrigger = { seat: hunter.seat, resume: "dawn" };
    enterPhase(state, effects, "hunter_shot", hunter.afk ? [] : [hunter.seat], "sequential");
    return;
  }

  if (finishIfOver(state, effects)) return;
  afterNightDeaths(state, effects);
}

function afterNightDeaths(state: WerewolfState, effects: WerewolfEffect[]): void {
  const wantsWords = state.day === 1 && state.spec.rules.day.lastWords.includes("night1");
  if (wantsWords && state.deathsTonight.length > 0) {
    state.wordsQueue = [...state.deathsTonight].sort((a, b) => a - b).filter((seat) => !seatOf(state, seat)?.afk);
    state.wordsNext = "day";
    enterPhase(state, effects, "day_last_words", state.wordsQueue, "sequential");
    return;
  }
  beginDay(state, effects);
}

function resolveHunter(
  state: WerewolfState,
  effects: WerewolfEffect[],
  action: PhaseAction | null,
): void {
  const trigger = state.hunterTrigger;
  if (!trigger) {
    finishGame(state, effects, null, "hunter_without_trigger");
    return;
  }
  const hunter = seatOf(state, trigger.seat);
  const target = action?.kind === "hunter" ? action.target : "pass";
  if (target !== "pass") {
    const victim = seatOf(state, target);
    if (victim && victim.alive) {
      victim.alive = false;
      victim.death = { day: state.day, cause: "hunter" };
      state.deathsToday.push(victim.seat);
      emit(effects, "hunter.shot", { day: state.day, seat: trigger.seat, target: victim.seat, role: "hunter" }, trigger.seat);
      emit(effects, "seat.died", { seat: victim.seat, cause: "hunter", day: state.day }, victim.seat);
    } else {
      emit(effects, "hunter.shot", { day: state.day, seat: trigger.seat, target: null, role: "hunter" }, trigger.seat);
    }
  } else {
    emit(effects, "hunter.shot", { day: state.day, seat: trigger.seat, target: null, role: "hunter" }, trigger.seat);
  }
  state.hunterTrigger = null;
  if (finishIfOver(state, effects)) return;

  if (trigger.resume === "dawn") {
    if (state.day === 1 && state.spec.rules.day.lastWords.includes("night1") && state.deathsTonight.length > 0) {
      state.wordsQueue = [...state.deathsTonight].sort((a, b) => a - b).filter((s) => !seatOf(state, s)?.afk);
      state.wordsNext = "day";
      enterPhase(state, effects, "day_last_words", state.wordsQueue, "sequential");
      return;
    }
    beginDay(state, effects);
    return;
  }

  if (state.spec.rules.day.lastWords.includes("daytime") && !hunter?.afk) {
    state.wordsQueue = [trigger.seat];
    state.wordsNext = "night";
    enterPhase(state, effects, "day_last_words", state.wordsQueue, "sequential");
    return;
  }
  nextNight(state, effects);
}

/* ── day ───────────────────────────────────────────────────────────── */

function beginDay(state: WerewolfState, effects: WerewolfEffect[]): void {
  state.deathsToday = [];
  let start = 0;
  if (state.day > 1) {
    if (state.deathsTonight.length > 0) start = Math.min(...state.deathsTonight);
    // A dead anchor falls out of the order on its own, which lands the table on the
    // seat after it. A living anchor does not: step one seat past the last speaker.
    else if (state.lastSpeaker !== null) start = (state.lastSpeaker + 1) % state.spec.seats;
  }
  const order = clockwise(state, start).filter((seat) => {
    const s = seatOf(state, seat);
    return !!s && s.alive && !s.afk;
  });
  enterPhase(state, effects, "day_speech", order, "sequential");
}

function resolveVote(state: WerewolfState, effects: WerewolfEffect[]): void {
  const votes: Record<number, number | "abstain"> = {};
  for (const [key, action] of Object.entries(state.pending)) {
    if (action?.kind === "vote") votes[Number(key)] = action.target;
  }
  state.votes = votes;
  const { counts, top } = tally(votes);
  if (top.length === 0) {
    emit(effects, "vote.tally", { day: state.day, counts, votes, exiled: null, tie: [] }, undefined);
    emit(effects, "no_exile", { day: state.day, reason: "abstain" }, undefined);
    state.publicLog.push({ kind: "vote", day: state.day, counts, votes, exiled: null, tie: [] });
    state.publicLog.push({ kind: "no_exile", day: state.day, reason: "abstain" });
    nextNight(state, effects);
    return;
  }
  if (top.length === 1) {
    emit(effects, "vote.tally", { day: state.day, counts, votes, exiled: top[0], tie: [] }, undefined);
    state.publicLog.push({ kind: "vote", day: state.day, counts, votes, exiled: top[0], tie: [] });
    exileSeat(state, effects, top[0]);
    return;
  }
  emit(effects, "vote.tally", { day: state.day, counts, votes, exiled: null, tie: top }, undefined);
  state.publicLog.push({ kind: "vote", day: state.day, counts, votes, exiled: null, tie: top });
  emit(effects, "pk.opened", { day: state.day, candidates: top }, undefined);
  state.pk = { candidates: top, votes: {} };
  enterPhase(state, effects, "day_pk_speech", top, "sequential");
}

function resolvePkVote(state: WerewolfState, effects: WerewolfEffect[]): void {
  const candidates = state.pk?.candidates ?? [];
  const votes: Record<number, number | "abstain"> = {};
  for (const [key, action] of Object.entries(state.pending)) {
    if (action?.kind === "vote" && (action.target === "abstain" || candidates.includes(action.target))) {
      votes[Number(key)] = action.target;
    }
  }
  if (state.pk) state.pk.votes = votes;
  const { counts, top } = tally(votes, candidates);
  if (top.length === 0) {
    emit(effects, "vote.tally", { day: state.day, counts, votes, exiled: null, tie: [], pk: true }, undefined);
    emit(effects, "no_exile", { day: state.day, reason: "tie" }, undefined);
    state.publicLog.push({ kind: "no_exile", day: state.day, reason: "tie" });
    nextNight(state, effects);
    return;
  }
  if (top.length === 1) {
    emit(effects, "vote.tally", { day: state.day, counts, votes, exiled: top[0], tie: [], pk: true }, undefined);
    state.publicLog.push({ kind: "vote", day: state.day, counts, votes, exiled: top[0], tie: [] });
    exileSeat(state, effects, top[0]);
    return;
  }
  emit(effects, "vote.tally", { day: state.day, counts, votes, exiled: null, tie: top, pk: true }, undefined);
  emit(effects, "no_exile", { day: state.day, reason: "tie" }, undefined);
  state.publicLog.push({ kind: "no_exile", day: state.day, reason: "tie" });
  nextNight(state, effects);
}

function exileSeat(state: WerewolfState, effects: WerewolfEffect[], seat: number): void {
  const target = seatOf(state, seat);
  if (!target) return;
  if (target.alive) {
    target.alive = false;
    target.death = { day: state.day, cause: "vote" };
    state.deathsToday.push(seat);
  }
  emit(effects, "exile", { day: state.day, seat }, undefined);
  emit(effects, "seat.died", { seat, cause: "vote", day: state.day }, seat);
  state.publicLog.push({ kind: "exile", day: state.day, seat });

  if (target.role === "hunter" && state.spec.rules.hunter.shootOn.includes("vote")) {
    state.hunterTrigger = { seat, resume: "exile" };
    enterPhase(state, effects, "hunter_shot", target.afk ? [] : [seat], "sequential");
    return;
  }
  if (finishIfOver(state, effects)) return;
  if (state.spec.rules.day.lastWords.includes("daytime") && !target.afk) {
    state.wordsQueue = [seat];
    state.wordsNext = "night";
    enterPhase(state, effects, "day_last_words", state.wordsQueue, "sequential");
    return;
  }
  nextNight(state, effects);
}

function speakLastWords(state: WerewolfState, effects: WerewolfEffect[], seat: number): void {
  const action = state.pending[seat];
  const text = action?.kind === "last_words" ? action.text : "";
  const target = seatOf(state, seat);
  if (target) target.lastWords = text;
  emit(effects, "last_words", { day: state.day, seat, text }, seat);
  state.publicLog.push({ kind: "last_words", day: state.day, seat, text });
}

function afterWords(state: WerewolfState, effects: WerewolfEffect[]): void {
  const next = state.wordsNext;
  state.wordsQueue = [];
  state.wordsNext = "night";
  if (finishIfOver(state, effects)) return;
  if (next === "day") beginDay(state, effects);
  else nextNight(state, effects);
}

function selfDestructSeat(state: WerewolfState, effects: WerewolfEffect[], seat: number): void {
  const wolf = seatOf(state, seat);
  if (!wolf || !wolf.alive) return;
  wolf.alive = false;
  wolf.death = { day: state.day, cause: "self_destruct" };
  state.deathsToday.push(seat);
  state.selfDestruct = seat;
  state.lastSpeaker = seat;
  emit(effects, "self_destruct", { day: state.day, seat, role: "wolf" }, seat);
  emit(effects, "seat.died", { seat, cause: "self_destruct", day: state.day }, seat);
  state.publicLog.push({ kind: "self_destruct", day: state.day, seat });
  if (state.spec.rules.day.selfDestructLastWords && !wolf.afk) {
    state.wordsQueue = [seat];
    state.wordsNext = "night";
    enterPhase(state, effects, "day_last_words", state.wordsQueue, "sequential");
    return;
  }
  if (finishIfOver(state, effects)) return;
  nextNight(state, effects);
}

function nextNight(state: WerewolfState, effects: WerewolfEffect[]): void {
  emit(effects, "round.closed", {
    day: state.day,
    alive: state.seats.filter((s) => s.alive).length,
  });
  if (state.day >= state.spec.rules.maxDays) {
    finishGame(state, effects, null, "day_limit");
    return;
  }
  state.day += 1;
  state.night = emptyNight();
  state.votes = {};
  state.pk = null;
  state.pending = {};
  state.deathsTonight = [];
  state.deathsToday = [];
  state.hunterTrigger = null;
  state.selfDestruct = null;
  emit(effects, "round.opened", { day: state.day, phase: "night_wolves", maxDays: state.spec.rules.maxDays });
  enterPhase(state, effects, "night_wolves", wolves(state), "sequential");
}

/* ── speech handling ───────────────────────────────────────────────── */

function handleSpeech(state: WerewolfState, effects: WerewolfEffect[], seat: number): void {
  const action = state.pending[seat];
  if (action?.kind !== "speech") return;
  if (action.selfDestruct) {
    selfDestructSeat(state, effects, seat);
    return;
  }
  emit(effects, "speech", { day: state.day, seat, text: action.text, pk: state.phase === "day_pk_speech" }, seat);
  state.publicLog.push({
    kind: "speech",
    day: state.day,
    seat,
    text: action.text,
    ...(state.phase === "day_pk_speech" ? { pk: true } : {}),
  });
  state.lastSpeaker = seat;
}

/* ── win / finish ──────────────────────────────────────────────────── */

function finishIfOver(state: WerewolfState, effects: WerewolfEffect[]): boolean {
  const win = checkWin(state);
  if (!win) return false;
  finishGame(state, effects, win.winner, win.reason);
  return true;
}

function checkWin(state: WerewolfState): { winner: WerewolfCamp; reason: string } | null {
  const alive = state.seats.filter((s) => s.alive);
  if (!alive.some((s) => s.role === "wolf")) return { winner: "good", reason: "wolves_out" };
  if (!alive.some((s) => isGod(s.role))) return { winner: "wolf", reason: "gods_wiped" };
  if (!alive.some((s) => s.role === "villager")) return { winner: "wolf", reason: "villagers_wiped" };
  return null;
}

function finishGame(
  state: WerewolfState,
  effects: WerewolfEffect[],
  winner: WerewolfCamp | null,
  reason: string,
): void {
  if (state.phase === "done") return;
  state.phase = "done";
  state.winner = winner;
  state.endReason = reason;
  emit(effects, "state.snapshot", { state });
  emit(effects, "match.finished", {
    winnerCamp: winner,
    winnerName: winner === "wolf" ? "狼人阵营" : winner === "good" ? "好人阵营" : null,
    reason,
    day: state.day,
    roles: state.seats.map((s) => ({ seat: s.seat, role: s.role, camp: s.camp })),
    dealSource: state.dealSource,
  });
  effects.push({ kind: "finish", winner, reason });
}

/* ── helpers ───────────────────────────────────────────────────────── */

function emit(
  effects: WerewolfEffect[],
  type: ArenaEvent["type"],
  payload: Record<string, unknown>,
  seat?: number,
): void {
  effects.push({
    kind: "emit",
    event: { type, ts: Date.now(), seat, payload },
  });
}

function wolves(state: WerewolfState): number[] {
  return state.seats
    .filter((s) => s.alive && s.role === "wolf" && !s.afk)
    .map((s) => s.seat)
    .sort((a, b) => a - b);
}

function activeSeats(state: WerewolfState): number[] {
  return state.seats
    .filter((s) => s.alive && !s.afk)
    .map((s) => s.seat)
    .sort((a, b) => a - b);
}

function seatOf(state: WerewolfState, seat: number): WerewolfSeatState | undefined {
  return state.seats.find((s) => s.seat === seat);
}

function clockwise(state: WerewolfState, start: number): number[] {
  const n = state.spec.seats;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((start + i) % n);
  return out;
}

function tally(
  votes: Record<number, number | "abstain">,
  allowed?: number[],
): { counts: Record<number, number>; top: number[] } {
  const counts: Record<number, number> = {};
  for (const value of Object.values(votes)) {
    if (typeof value !== "number") continue;
    if (allowed && !allowed.includes(value)) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  const top =
    max > 0
      ? Object.keys(counts)
          .map(Number)
          .filter((seat) => counts[seat] === max)
          .sort((a, b) => a - b)
      : [];
  return { counts, top };
}

function clamp(text: unknown, max: number): string {
  return typeof text === "string" ? text.trim().slice(0, max) : "";
}

export type { PublicEntry };

/* ── model-facing parsing ──────────────────────────────────────────── */

/** Seats are 1-based in prompts and JSON; the engine stores 0-based indexes. */
function oneBasedSeat(value: unknown): number | null {
  const text = typeof value === "string" ? value.trim().replace(/号$/, "") : "";
  const n = typeof value === "number" ? value : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 9) return null;
  return n - 1;
}

/**
 * Turn a model's JSON into an action. Unknown shapes become null so the caller can
 * ask for one repair; the reducer validates the result again before it counts.
 */
export function coerceWerewolfAction(phase: WerewolfPhase, raw: unknown): PhaseAction | null {
  if (!raw || typeof raw !== "object") return null;
  const content = raw as Record<string, unknown>;
  switch (phase) {
    case "night_wolves": {
      const target = content.target;
      const empty = target === "空刀" || target === "empty" || target === "空";
      const seat = empty ? null : oneBasedSeat(target);
      if (!empty && seat === null) return null;
      return { kind: "wolf", target: empty ? "empty" : seat!, talk: clamp(content.talk, 200) };
    }
    case "night_seer": {
      const seat = oneBasedSeat(content.target);
      return seat === null ? null : { kind: "seer", target: seat };
    }
    case "night_witch": {
      const action = String(content.action ?? "").trim();
      if (action === "none" || action === "不用" || action === "不使用") {
        return { kind: "witch", action: "none", target: null };
      }
      if (action === "save" || action === "救" || action === "解药") {
        return { kind: "witch", action: "save", target: null };
      }
      if (action === "poison" || action === "毒" || action === "毒药") {
        const seat = oneBasedSeat(content.target);
        return seat === null ? null : { kind: "witch", action: "poison", target: seat };
      }
      return null;
    }
    case "day_speech":
    case "day_pk_speech": {
      const rawSpeech =
        typeof content.speech === "string"
          ? content.speech
          : typeof content.text === "string"
            ? content.text
            : "";
      const speech = salvageSpeech(rawSpeech);
      if (!speech) return null;
      return { kind: "speech", text: clamp(speech, 1200), ...(content.self_destruct === true ? { selfDestruct: true } : {}) };
    }
    case "day_vote":
    case "day_pk_vote": {
      const vote = content.vote;
      if (vote === "弃票" || vote === "abstain" || vote === "弃权") {
        return { kind: "vote", target: "abstain" };
      }
      const seat = oneBasedSeat(vote);
      return seat === null ? null : { kind: "vote", target: seat };
    }
    case "hunter_shot": {
      const target = content.target;
      if (target === "pass" || target === "不开枪" || target === "pass") {
        return { kind: "hunter", target: "pass" };
      }
      const seat = oneBasedSeat(target);
      return seat === null ? null : { kind: "hunter", target: seat };
    }
    case "day_last_words": {
      const rawSpeech =
        typeof content.speech === "string"
          ? content.speech
          : typeof content.text === "string"
            ? content.text
            : "";
      return { kind: "last_words", text: clamp(salvageSpeech(rawSpeech), 800) };
    }
    default:
      return null;
  }
}

/** Exposed for the runtime's one repair turn. */
export function validatePhaseAction(
  state: WerewolfState,
  seat: WerewolfSeatState,
  raw: PhaseAction | null,
): PhaseAction | null {
  return validateAction(state, seat, raw);
}
