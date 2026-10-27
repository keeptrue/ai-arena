/**
 * Declarative board ledger. Pure: no I/O, no clock, no notion of what a move
 * *means*.
 *
 * A ruleset may declare `board.settle`: for every combination of the declared
 * `choice` slot, what each side's meters gain or lose. The engine only looks up
 * the exact string a slot returned and adds the declared numbers, which keeps
 * rule semantics in the ruleset while making the arithmetic reproducible.
 *
 * Two invariants this module exists to protect:
 *   1. readings are keyed by team id, never by the per-round blind letters, so a
 *      rotating A/B map can never hand one side's blood to the other;
 *   2. a round that was collected always has a reading — no model, no gap.
 */

import type {
  BoardSpec,
  RubricDimension,
  Settlement,
  SettlementSide,
  TeamScoreLine,
  TeamState,
} from "./types";

export type MeterValues = Record<string, Record<string, number>>;

/** Minimal shape of a round, so both `RoundRecord` and test fixtures fit. */
export interface BoardRoundLike {
  round: number;
  settlement?: { sides?: Array<{ teamId: string; state: Record<string, number> }> } | null;
  verdict?: { scores?: Array<{ teamId: string; state?: Record<string, number> | null }> } | null;
}

/** Team ids in the order the settlement table addresses them (`a` then `b`). */
export function boardOrder(teams: Array<Pick<TeamState, "id" | "idx">>): string[] {
  return [...teams].sort((x, y) => x.idx - y.idx).map((t) => t.id);
}

export function initialBoardValues(board: BoardSpec, teamIds: string[]): MeterValues {
  const out: MeterValues = {};
  for (const id of teamIds) {
    out[id] = Object.fromEntries(board.meters.map((m) => [m.key, m.init]));
  }
  return out;
}

/**
 * Fold every round into one absolute reading per team. A settled round wins over
 * whatever the judge wrote; legacy rounds fall back to the judge's `state`.
 */
export function foldBoardValues(
  board: BoardSpec | undefined,
  teamIds: string[],
  rounds: BoardRoundLike[],
): MeterValues {
  if (!board) return {};
  const values = initialBoardValues(board, teamIds);
  for (const entry of rounds) {
    const settled = entry.settlement?.sides;
    if (settled?.length) {
      for (const side of settled) {
        const target = values[side.teamId];
        if (!target) continue;
        for (const meter of board.meters) {
          const value = side.state[meter.key];
          if (typeof value === "number" && Number.isFinite(value)) target[meter.key] = value;
        }
      }
      continue;
    }
    for (const line of entry.verdict?.scores ?? []) {
      const target = values[line.teamId];
      if (!target || !line.state) continue;
      for (const meter of board.meters) {
        const value = line.state[meter.key];
        if (typeof value === "number" && Number.isFinite(value)) target[meter.key] = value;
      }
    }
  }
  return values;
}

function cellFor(board: BoardSpec, a: string, b: string) {
  return board.settle?.cells.find((cell) => cell.a === a && cell.b === b);
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

function meterText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Team-named ledger line. No blind letters: the audience should not solve a puzzle. */
export function renderSettlementSummary(input: {
  board: BoardSpec;
  teams: Array<Pick<TeamState, "id" | "idx" | "name">>;
  sides: SettlementSide[];
  /** Value a forfeited seat stands in as, shown verbatim in the move list. */
  forfeit: string;
}): string {
  const { board, sides } = input;
  const nameOf = (teamId: string) => input.teams.find((t) => t.id === teamId)?.name ?? "某方";
  const ordered = boardOrder(input.teams).map((id) => sides.find((s) => s.teamId === id)).filter(Boolean) as SettlementSide[];

  const bars = board.meters.filter((m) => m.kind !== "count");
  const counts = board.meters.filter((m) => m.kind === "count");

  const readout = bars
    .map((meter) => `${meter.label}：${ordered.map((s) => `${nameOf(s.teamId)} ${meterText(s.state[meter.key] ?? 0)}`).join(" / ")}`)
    .join(" · ");
  const tally = counts.length
    ? `（${counts
        .map(
          (meter) =>
            `${meter.label} ${ordered
              .map((s) => `${nameOf(s.teamId)} ${meterText(s.state[meter.key] ?? 0)} 次`)
              .join(" / ")}`,
        )
        .join(" · ")}）`
    : "";

  const moves = ordered
    .map((s) => `${nameOf(s.teamId)} ${s.move ?? `弃权记${input.forfeit}`}`)
    .join("、");
  const deltas = ordered
    .map((s) => {
      const parts = bars.map((meter) => signed(s.delta[meter.key] ?? 0)).join("/");
      return `${nameOf(s.teamId)} ${parts}`;
    })
    .join("、");

  return `${readout}${tally}｜本轮 ${moves} → ${deltas}`;
}

export interface SettlementInput {
  board: BoardSpec;
  teams: Array<Pick<TeamState, "id" | "idx" | "name">>;
  /** teamId → the raw value of `board.settle.by`, or null when it forfeited. */
  moves: Array<{ teamId: string; value: string | null }>;
  prior: MeterValues;
  round: number;
}

/**
 * Apply the declared table. Returns null when the board has no ledger, the roster
 * is not exactly two sides, or the combination is not declared — never a guessed
 * zero, because a silent default is how a ledger turns into fiction.
 */
export function settleRound(input: SettlementInput): Settlement | null {
  const { board } = input;
  const settle = board.settle;
  if (!settle) return null;
  if (input.teams.length !== 2) return null;

  const order = boardOrder(input.teams);
  const raw = order.map((id) => input.moves.find((m) => m.teamId === id)?.value ?? null);
  const substituted = raw.some((value) => value === null);
  const moves = raw.map((value) => value ?? settle.forfeit);

  const cell = cellFor(board, moves[0], moves[1]);
  if (!cell) return null;

  const sides: SettlementSide[] = order.map((teamId, i) => {
    const delta = cell.delta[i] ?? {};
    const before = input.prior[teamId] ?? {};
    const state: Record<string, number> = {};
    const applied: Record<string, number> = {};
    for (const meter of board.meters) {
      const base = typeof before[meter.key] === "number" ? before[meter.key] : meter.init;
      const change = typeof delta[meter.key] === "number" && Number.isFinite(delta[meter.key]) ? delta[meter.key] : 0;
      state[meter.key] = Number((base + change).toFixed(3));
      if (change !== 0) applied[meter.key] = change;
    }
    return { teamId, move: raw[i], substituted: raw[i] === null, delta: applied, state };
  });

  return {
    round: input.round,
    by: settle.by,
    forfeit: settle.forfeit,
    sides,
    substituted,
    summary: renderSettlementSummary({ board, teams: input.teams, sides, forfeit: settle.forfeit }),
  };
}

/* ── judge / ledger arbitration ────────────────────────────────────── */

export interface ScoreCorrection {
  teamId: string;
  kind: "state" | "derive";
  field: string;
  /** What the judge wrote; null when it omitted the field. */
  judge: number | null;
  /** What the ledger says. */
  engine: number;
}

function clampScore(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Overwrite the mechanical parts of the judge's score lines with ledger values:
 * absolute `state` per meter, and any dimension that declared a `derive`.
 * Everything the judge is actually qualified to judge stays untouched.
 */
export function applySettlement(input: {
  settlement: Settlement | null | undefined;
  board?: BoardSpec;
  dimensions: RubricDimension[];
  scores: TeamScoreLine[];
}): { scores: TeamScoreLine[]; corrections: ScoreCorrection[] } {
  const { settlement, board, dimensions } = input;
  if (!settlement || !board) return { scores: input.scores, corrections: [] };

  const corrections: ScoreCorrection[] = [];
  const scores = input.scores.map((line) => {
    const side = settlement.sides.find((s) => s.teamId === line.teamId);
    if (!side) return line;

    const judgeState = line.state ?? null;
    const nextState = { ...(judgeState ?? {}) };
    for (const meter of board.meters) {
      const engine = side.state[meter.key];
      if (typeof engine !== "number") continue;
      const judge = judgeState?.[meter.key];
      // Omitting the field is expected on a ledger board; only a *conflicting* number
      // is worth an anomaly.
      if (typeof judge === "number" && judge !== engine) {
        corrections.push({
          teamId: line.teamId,
          kind: "state",
          field: meter.key,
          judge,
          engine,
        });
      }
      nextState[meter.key] = engine;
    }

    const dims = { ...line.dimensions };
    for (const dim of dimensions) {
      if (!dim.derive) continue;
      const change = side.delta[dim.derive.meter] ?? 0;
      const raw = dim.derive.base + (dim.derive.per ?? 1) * change;
      const engine = clampScore(raw, dim.derive.min ?? 0, dim.derive.max ?? 10);
      const judge = typeof dims[dim.key] === "number" ? dims[dim.key] : null;
      if (judge !== null && Math.abs(judge - engine) > 0.001) {
        corrections.push({ teamId: line.teamId, kind: "derive", field: dim.key, judge, engine });
      }
      dims[dim.key] = engine;
    }

    const weighted = dimensions.reduce((sum, dim) => sum + (dims[dim.key] ?? 0) * dim.weight, 0);
    return {
      ...line,
      dimensions: dims,
      weighted: Number(weighted.toFixed(3)),
      state: Object.keys(nextState).length ? nextState : undefined,
    };
  });

  return { scores, corrections };
}

/** Rounds where a declared ledger produced a reading that disagrees with the clamp range. */
export function outOfRange(board: BoardSpec | undefined, settlement: Settlement | null | undefined) {
  if (!board || !settlement) return [];
  const issues: Array<{ meter: string; limit: "min" | "max"; value: number }> = [];
  for (const side of settlement.sides) {
    for (const meter of board.meters) {
      const value = side.state[meter.key];
      if (typeof value !== "number") continue;
      if (value < meter.min) issues.push({ meter: meter.key, limit: "min", value });
      if (value > meter.max) issues.push({ meter: meter.key, limit: "max", value });
    }
  }
  return issues;
}
