/**
 * Board read-out helpers. Pure: no I/O, no React, no semantics.
 *
 * The rules decide what a number means; this module only coerces it into the
 * declared range and folds per-round readings into one snapshot for the UI.
 */

import type { BoardSpec } from "@/engine/types";

export interface BoardIssue {
  code: "state_clamped" | "state_unknown" | "marks_filtered";
  detail?: string;
}

/** Coerce one side's raw `state` object against the declared meters. */
export function parseBoardState(
  board: BoardSpec | undefined,
  raw: unknown,
): { state: Record<string, number>; issues: BoardIssue[] } {
  const issues: BoardIssue[] = [];
  const state: Record<string, number> = {};
  if (!board) return { state, issues };

  const declared = new Set(board.meters.map((m) => m.key));
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  for (const key of Object.keys(source)) {
    if (!declared.has(key)) issues.push({ code: "state_unknown", detail: key });
  }

  for (const meter of board.meters) {
    const value = Number(source[meter.key]);
    if (!Number.isFinite(value)) continue;
    const clamped = Math.min(meter.max, Math.max(meter.min, value));
    if (clamped !== value) issues.push({ code: "state_clamped", detail: meter.key });
    state[meter.key] = clamped;
  }

  return { state, issues };
}

/** Marks are square numbers (mines). Only the track's range is meaningful. */
export function parseMarks(
  board: BoardSpec | undefined,
  raw: unknown,
): { marks: number[]; issues: BoardIssue[] } {
  if (!board?.marks) return { marks: [], issues: [] };
  const track = board.meters.find((m) => m.kind === "track");
  if (!track || !Array.isArray(raw)) return { marks: [], issues: [] };

  const marks = Array.from(
    new Set(
      raw
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && Number.isInteger(v))
        .filter((v) => v >= track.min && v <= track.max),
    ),
  )
    .sort((a, b) => a - b)
    .slice(0, 16);

  const issues: BoardIssue[] = marks.length < raw.length ? [{ code: "marks_filtered" }] : [];
  return { marks, issues };
}

export interface BoardRoundInput {
  round: number;
  verdict: { scores?: Array<{ teamId: string; state?: Record<string, number> | null }> } | null;
}

export interface BoardSnapshot {
  /** teamId → meter key → value. Starts from each meter's `init`. */
  values: Record<string, Record<string, number>>;
  /** Last round that actually carried a reading; 0 means none yet. */
  round: number;
  /** Rounds have happened, but the latest one carried no reading. */
  stale: boolean;
}

export function foldBoard(
  board: BoardSpec | undefined,
  teamIds: string[],
  rounds: BoardRoundInput[],
): BoardSnapshot {
  const values: Record<string, Record<string, number>> = {};
  if (!board) return { values, round: 0, stale: false };

  for (const teamId of teamIds) {
    values[teamId] = Object.fromEntries(board.meters.map((m) => [m.key, m.init]));
  }

  let lastRound = 0;
  for (const entry of rounds) {
    if (!entry.verdict?.scores) continue;
    let touched = false;
    for (const line of entry.verdict.scores) {
      const target = values[line.teamId];
      if (!target || !line.state) continue;
      for (const meter of board.meters) {
        const value = line.state[meter.key];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        target[meter.key] = value;
        touched = true;
      }
    }
    if (touched) lastRound = entry.round;
  }

  const latestRound = rounds.length ? rounds[rounds.length - 1].round : 0;
  return { values, round: lastRound, stale: latestRound > 0 && lastRound < latestRound };
}

/** Per-team, per-meter change between two snapshots (for the round cards). */
export function boardDelta(
  prev: Record<string, number> | undefined,
  next: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!prev || !next) return out;
  for (const key of Object.keys(next)) {
    const before = prev[key];
    if (typeof before !== "number") continue;
    const diff = Number((next[key] - before).toFixed(3));
    if (diff !== 0) out[key] = diff;
  }
  return out;
}
