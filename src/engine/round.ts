/**
 * Round engine. Pure: (state, action) -> (state, effects).
 *
 * It knows nothing about the rules' meaning. It only guarantees three things:
 *   1. simultaneity — every participant submits before anything is revealed,
 *   2. completeness — the judge only runs once everyone is ready or forfeited,
 *   3. ledger — every thought, submission and verdict becomes an event.
 */

import { teamLetters } from "./blueprint";
import { boardOrder, foldBoardValues, settleRound } from "./ledger";
import type {
  ArenaEvent,
  Blueprint,
  Effect,
  Intervention,
  JudgeVerdict,
  MatchAction,
  ModelSnapshot,
  MatchState,
  ParticipantState,
  ReduceResult,
  RoundRecord,
  Settlement,
  Submission,
  TeamState,
} from "./types";

/* ── helpers ───────────────────────────────────────────────────────── */

export function budgetExhausted(budget: MatchState["budget"]): boolean {
  // Token usage is metered, never enforced: 输入/输出 token 都不设上限。The only
  // guard is the call count, which stops a runaway loop before it bills forever.
  void budget.tokens;
  void budget.maxTokens;
  return budget.calls + 1 > budget.maxCalls;
}

function teamById(state: MatchState, teamId: string): TeamState | undefined {
  return state.teams.find((t) => t.id === teamId);
}

function membersOf(state: MatchState, teamId: string): ParticipantState[] {
  return state.participants.filter((p) => p.teamId === teamId);
}

/** A round is collectable when every participant has submitted or forfeited. */
export function allCollected(state: MatchState): boolean {
  return state.participants.every((p) => {
    const sub = state.pending[p.id];
    return sub && (sub.status === "ready" || sub.status === "forfeit");
  });
}

export function standings(state: MatchState): TeamState[] {
  return [...state.teams].sort((a, b) => b.totalScore - a.totalScore);
}

/**
 * The judge scores each *team* for the round (it reads every member's submission
 * together), so the round score is exactly that weighted score. A team missing a
 * member is already penalised by having less to show — no extra arithmetic.
 */
function computeTeamRoundScores(state: MatchState, verdict: JudgeVerdict): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of state.teams) out[t.id] = 0;
  for (const line of verdict.scores) {
    if (out[line.teamId] !== undefined) out[line.teamId] = Number(line.weighted.toFixed(3));
  }
  return out;
}

function emptyPending(): Record<string, Submission> {
  return {};
}

/** A forfeit is per-round; only the team-level counter persists for disqualification. */
function resetStatuses(participants: ParticipantState[]): ParticipantState[] {
  return participants.map((p) => ({ ...p, status: "idle" as const }));
}

/**
 * Settle the declared ledger before the judge is called. Pure and deterministic:
 * the numbers the audience sees must not depend on how well a model can add.
 */
export function computeSettlement(state: MatchState): Settlement | null {
  const board = state.blueprint.board;
  if (!board?.settle || state.suddenDeath) return null;
  const teamIds = boardOrder(state.teams);
  const moves = state.participants.map((p) => {
    const sub = state.pending[p.id];
    const value = sub && sub.status === "ready" ? sub.content[board.settle!.by] : undefined;
    return { teamId: p.teamId, value: value === undefined || value === null ? null : String(value) };
  });
  return settleRound({
    board,
    teams: state.teams,
    moves,
    prior: foldBoardValues(board, teamIds, state.history),
    round: state.round,
  });
}

/* ── construction ──────────────────────────────────────────────────── */

export function createMatchState(input: {
  matchId: string;
  rulesetId: string;
  blueprint: Blueprint;
  seed: string;
  teams: TeamState[];
  participants: ParticipantState[];
  judgeModel: ModelSnapshot | null;
  budget: { maxCalls: number; maxTokens: number };
  at: number;
}): MatchState {
  return {
    matchId: input.matchId,
    rulesetId: input.rulesetId,
    blueprint: input.blueprint,
    seed: input.seed,
    teams: input.teams,
    participants: input.participants,
    judgeModel: input.judgeModel,
    round: 0,
    phase: "idle",
    pending: {},
    history: [],
    suddenDeath: false,
    budget: { ...input.budget, calls: 0, tokens: 0 },
    paused: false,
    winnerTeamId: null,
    endReason: null,
    begunAt: input.at,
  };
}

/* ── reducer ───────────────────────────────────────────────────────── */

export function reduce(state: MatchState, action: MatchAction): ReduceResult {
  switch (action.kind) {
    case "start":
      return onStart(state, action.at);
    case "submit":
      return onSubmit(state, action.submission);
    case "verdict":
      return onVerdict(state, action.verdict);
    case "dm":
      return onDm(state, action.intervention);
    case "recall":
      return recallSubmission(state, action.participantId);
    case "abort":
      return finish({ ...state }, [], null, `aborted:${action.reason}`, Date.now());
  }
}

/**
 * Pick a match back up after the process died: ask again for exactly what the
 * round is still missing, and call the judge only when the round is actually in.
 *
 * Submissions already in `state.pending` are never re-requested, and `onSubmit`
 * ignores duplicates anyway, so a recovery can never make a seat act twice.
 */
export function recoverRound(state: MatchState): ReduceResult {
  if (state.phase === "idle" || state.phase === "done") return { state, effects: [] };

  const settlement = computeSettlement(state);
  if (state.phase === "judging") {
    return {
      state,
      effects: [
        { kind: "call_judge", round: state.round, sudden: state.suddenDeath, settlement },
      ],
    };
  }

  const owed = state.participants
    .filter((p) => !state.pending[p.id] && p.status !== "forfeit")
    .map((p) => p.id);
  if (owed.length > 0) return { state, effects: [{ kind: "call_participants", ids: owed }] };

  // Everyone is in but the phase never moved on: the last submit died before the
  // judge was called. Asking the judge now is the same step, not a second one.
  return {
    state,
    effects: [{ kind: "call_judge", round: state.round, sudden: state.suddenDeath, settlement }],
  };
}

function onStart(state: MatchState, at: number): ReduceResult {
  const bp = state.blueprint;
  const next: MatchState = {
    ...state,
    round: 1,
    phase: "collecting",
    begunAt: at,
    participants: resetStatuses(state.participants),
    pending: emptyPending(),
  };

  const effects: Effect[] = [
    {
      kind: "emit",
      event: {
        type: "match.created",
        ts: at,
        payload: {
          matchId: next.matchId,
          rulesetId: next.rulesetId,
          name: bp.name,
          tagline: bp.tagline,
          rounds: bp.rounds,
          tieThreshold: bp.victory.tieThreshold,
          slots: bp.submission.slots,
          dimensions: bp.rubric.dimensions,
          board: bp.board ?? null,
          judgeBrief: bp.judgeBrief ?? "",
          seed: next.seed,
          teams: next.teams.map((t) => ({
            id: t.id,
            idx: t.idx,
            name: t.name,
            color: t.color,
            members: membersOf(next, t.id).map((m) => ({
              id: m.id,
              seat: m.seat,
              display: m.model.display,
              provider: m.model.providerName,
              modelId: m.model.modelId,
              reasoning: m.model.reasoningEffort ?? null,
            })),
          })),
        },
      },
    },
    {
      kind: "emit",
      event: {
        type: "round.opened",
        ts: at,
        payload: { round: 1, sudden: false, rounds: bp.rounds, slots: bp.submission.slots },
      },
    },
    { kind: "call_participants", ids: next.participants.map((p) => p.id) },
  ];

  return { state: next, effects };
}

function onSubmit(state: MatchState, submission: Submission): ReduceResult {
  if (state.phase !== "collecting" && state.phase !== "sudden") return { state, effects: [] };
  if (state.pending[submission.participantId]) return { state, effects: [] };

  const participant = state.participants.find((p) => p.id === submission.participantId);
  if (!participant) return { state, effects: [] };

  const next: MatchState = {
    ...state,
    participants: state.participants.map((p) =>
      p.id === submission.participantId
        ? { ...p, status: submission.status === "forfeit" ? "forfeit" : "ready" }
        : p,
    ),
    pending: { ...state.pending, [submission.participantId]: submission },
    budget: {
      ...state.budget,
      calls: state.budget.calls + 1,
      tokens:
        state.budget.tokens + submission.usage.promptTokens + submission.usage.completionTokens,
      // A subset of `tokens`, not an addition to it: the same input, seen twice.
      cachedTokens: (state.budget.cachedTokens ?? 0) + (submission.usage.cachedPromptTokens ?? 0),
      cacheWriteTokens: (state.budget.cacheWriteTokens ?? 0) + (submission.usage.cacheWriteTokens ?? 0),
    },
  };

  const now = Date.now();
  const effects: Effect[] = [];

  for (const anomaly of submission.anomalies) {
    effects.push({
      kind: "emit",
      event: {
        type: "anomaly",
        seat: submission.seat,
        teamId: participant.teamId,
        ts: now,
        payload: { round: next.round, participantId: participant.id, code: anomaly },
      },
    });
  }

  if (submission.status === "forfeit") {
    effects.push({
      kind: "emit",
      event: {
        type: "seat.forfeit",
        seat: submission.seat,
        teamId: participant.teamId,
        ts: now,
        payload: {
          round: next.round,
          participantId: participant.id,
          reason: submission.anomalies[0] ?? "unknown",
        },
      },
    });
    next.teams = next.teams.map((t) =>
      t.id === participant.teamId ? { ...t, forfeits: t.forfeits + 1 } : t,
    );
  } else {
    effects.push({
      kind: "emit",
      event: {
        type: "seat.submitted",
        seat: submission.seat,
        teamId: participant.teamId,
        ts: now,
        payload: {
          round: next.round,
          participantId: participant.id,
          content: submission.content,
          thinking: submission.thinking,
          usage: submission.usage,
          latencyMs: submission.latencyMs,
        },
      },
    });
  }

  if (!allCollected(next)) return { state: next, effects };

  // Everyone is in (or forfeited). Close the gate and call the judge.
  const ready = Object.values(next.pending).filter((s) => s.status === "ready").length;
  const forfeits = Object.values(next.pending).filter((s) => s.status === "forfeit").length;
  next.phase = "judging";

  effects.push({
    kind: "emit",
    event: {
      type: "round.collected",
      ts: now,
      payload: { round: next.round, ready, forfeits, total: next.participants.length },
    },
  });
  effects.push({
    kind: "call_judge",
    round: next.round,
    sudden: next.suddenDeath,
    settlement: computeSettlement(next),
  });
  return { state: next, effects };
}

function onVerdict(state: MatchState, verdict: JudgeVerdict): ReduceResult {
  const now = Date.now();
  const next: MatchState = {
    ...state,
    teams: state.teams.map((t) => ({ ...t })),
    pending: { ...state.pending },
    history: [...state.history],
    budget: {
      ...state.budget,
      calls: state.budget.calls + 1,
      tokens: state.budget.tokens + verdict.usage.promptTokens + verdict.usage.completionTokens,
      cachedTokens: (state.budget.cachedTokens ?? 0) + (verdict.usage.cachedPromptTokens ?? 0),
      cacheWriteTokens: (state.budget.cacheWriteTokens ?? 0) + (verdict.usage.cacheWriteTokens ?? 0),
    },
  };

  const teamScores = next.suddenDeath ? {} : computeTeamRoundScores(next, verdict);
  next.teams = next.teams.map((t) => ({
    ...t,
    roundScore: teamScores[t.id] ?? 0,
    totalScore: Number((t.totalScore + (teamScores[t.id] ?? 0)).toFixed(3)),
  }));

  const record: RoundRecord = {
    round: next.round,
    sudden: next.suddenDeath,
    closedAt: now,
    submissions: Object.values(next.pending).map((s) => {
      const p = next.participants.find((x) => x.id === s.participantId)!;
      return {
        participantId: s.participantId,
        seat: s.seat,
        teamId: p.teamId,
        status: s.status,
        thinking: s.thinking,
        content: s.content,
      };
    }),
    verdict,
    teamScores,
    settlement: verdict.settlement ?? null,
  };
  next.history.push(record);

  const effects: Effect[] = [
    {
      kind: "emit",
      event: {
        type: "round.verdict",
        ts: now,
        payload: {
          round: next.round,
          sudden: next.suddenDeath,
          blindMap: verdict.blindMap,
          scores: verdict.scores,
          marks: verdict.marks ?? [],
          verdict: verdict.verdict,
          publicSummary: verdict.publicSummary,
          judge: verdict.judgeModel.display,
          suddenWinnerTeamId: verdict.suddenWinnerTeamId ?? null,
          settlement: verdict.settlement ?? null,
        },
      },
    },
    {
      kind: "emit",
      event: {
        type: "round.closed",
        ts: now,
        payload: {
          round: next.round,
          teamScores,
          totals: Object.fromEntries(next.teams.map((t) => [t.id, t.totalScore])),
          publicSummary: verdict.publicSummary,
          settlement: record.settlement ?? null,
        },
      },
    },
  ];

  // A sudden-death round ends the match outright.
  if (next.suddenDeath) {
    const winner = verdict.suddenWinnerTeamId ?? null;
    return finish(next, effects, winner, "sudden_death", now);
  }

  // Forfeit limit: a team that lets the arena down twice is out.
  const disqualified = next.teams.filter((t) => t.forfeits >= 2);
  if (disqualified.length > 0 && disqualified.length < next.teams.length) {
    const dead = new Set(disqualified.map((t) => t.id));
    const candidates = standings(next).filter((t) => !dead.has(t.id));
    return finish(next, effects, candidates[0]?.id ?? null, "forfeit_limit", now);
  }

  if (next.round < next.blueprint.rounds) {
    next.round += 1;
    next.phase = "collecting";
    next.pending = emptyPending();
    next.participants = resetStatuses(next.participants);
    effects.push({
      kind: "emit",
      event: {
        type: "round.opened",
        ts: now,
        payload: {
          round: next.round,
          sudden: false,
          rounds: next.blueprint.rounds,
          slots: next.blueprint.submission.slots,
        },
      },
    });
    effects.push({ kind: "call_participants", ids: next.participants.map((p) => p.id) });
    return { state: next, effects };
  }

  // Regulation is over: decide, or send them back out for a sudden-death round.
  const ranked = standings(next);
  const gap = ranked.length > 1 ? ranked[0].totalScore - ranked[1].totalScore : Infinity;
  if (gap < next.blueprint.victory.tieThreshold) {
    next.suddenDeath = true;
    next.round += 1;
    next.phase = "sudden";
    next.pending = emptyPending();
    next.participants = resetStatuses(next.participants);
    effects.push({
      kind: "emit",
      event: {
        type: "round.opened",
        ts: now,
        payload: {
          round: next.round,
          sudden: true,
          rounds: next.blueprint.rounds,
          slots: next.blueprint.submission.slots,
          gap: Number(gap.toFixed(3)),
        },
      },
    });
    effects.push({ kind: "call_participants", ids: next.participants.map((p) => p.id) });
    return { state: next, effects };
  }

  return finish(next, effects, ranked[0]?.id ?? null, "rubric_total", now);
}

function onDm(state: MatchState, intervention: Intervention): ReduceResult {
  const now = Date.now();
  const next: MatchState = { ...state };
  const effects: Effect[] = [
    { kind: "emit", event: { type: "dm.intervened", ts: now, payload: { ...intervention } } },
  ];

  if (intervention.kind === "pause") next.paused = true;
  if (intervention.kind === "resume") next.paused = false;

  if (intervention.kind === "score" && intervention.teamId) {
    next.teams = next.teams.map((t) =>
      t.id === intervention.teamId
        ? { ...t, totalScore: Number((t.totalScore + (intervention.delta ?? 0)).toFixed(3)) }
        : t,
    );
  }

  if (intervention.kind === "forfeit" && intervention.participantId) {
    next.participants = next.participants.map((p) =>
      p.id === intervention.participantId ? { ...p, status: "forfeit", forfeits: p.forfeits + 1 } : p,
    );
  }

  return { state: next, effects };
}

/**
 * Re-open one participant's turn inside the current round.
 *
 * A cut window is indistinguishable from a dead model, and a false one must not
 * cost the match: the seat goes back to "has not answered", the strike its team
 * was charged is refunded, and the runtime calls it again. Legal only while the
 * round is still being collected — once the judge holds the material, rewinding
 * would be rewriting a verdict.
 */
export function recallSubmission(state: MatchState, participantId: string): ReduceResult {
  if (state.phase !== "collecting" && state.phase !== "sudden") return { state, effects: [] };
  const submission = state.pending[participantId];
  if (!submission || submission.status !== "forfeit") return { state, effects: [] };
  const participant = state.participants.find((p) => p.id === participantId);
  if (!participant) return { state, effects: [] };

  const pending = { ...state.pending };
  delete pending[participantId];

  const next: MatchState = {
    ...state,
    pending,
    participants: state.participants.map((p) =>
      p.id === participantId ? { ...p, status: "idle" } : p,
    ),
    teams: state.teams.map((t) =>
      t.id === participant.teamId ? { ...t, forfeits: Math.max(0, t.forfeits - 1) } : t,
    ),
  };

  return {
    state: next,
    effects: [
      {
        kind: "emit",
        event: {
          type: "seat.recalled",
          seat: participant.seat,
          teamId: participant.teamId,
          ts: Date.now(),
          payload: { round: next.round, participantId, reason: "manual" },
        },
      },
      { kind: "call_participants", ids: [participantId] },
    ],
  };
}

function finish(
  state: MatchState,
  effects: Effect[],
  winnerTeamId: string | null,
  reason: string,
  at: number,
): ReduceResult {
  const next: MatchState = { ...state, phase: "done", winnerTeamId, endReason: reason };
  const ranked = standings(next);
  const winner = next.teams.find((t) => t.id === winnerTeamId);

  effects.push(
    {
      kind: "emit",
      event: {
        type: "state.snapshot",
        ts: at,
        payload: { state: JSON.parse(JSON.stringify(next)) as Record<string, unknown> },
      },
    },
    {
      kind: "emit",
      event: {
        type: "match.finished",
        ts: at,
        payload: {
          winnerTeamId,
          winnerTeamName: winner?.name ?? null,
          reason,
          rounds: next.round,
          standings: ranked.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            total: t.totalScore,
          })),
          budget: next.budget,
        },
      },
    },
    { kind: "finish", winnerTeamId, reason },
  );
  return { state: next, effects };
}

/* ── small shared utilities ────────────────────────────────────────── */

export function blindMapFor(seed: string, round: number, teamIds: string[]): Record<string, string> {
  // Deterministic per round so a replay reproduces the same anonymisation.
  const letters = teamLetters(teamIds.length);
  const shuffled = [...teamIds].sort((a, b) => {
    const ha = hash32(`${seed}|${round}|${a}`);
    const hb = hash32(`${seed}|${round}|${b}`);
    return ha - hb;
  });
  const map: Record<string, string> = {};
  letters.forEach((letter, i) => {
    map[letter] = shuffled[i];
  });
  return map;
}

function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export type { ArenaEvent };
