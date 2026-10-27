/**
 * Duplicate-seat helpers for the launch page. Pure: no I/O, no React, no database.
 *
 * Any seat may hold any model — including the same model twice. A mirror table
 * (同一模型自我对弈) is a legitimate stress test, so the roster never blocks on
 * duplicates: it labels them. These helpers are what the labels are computed from.
 */

/** One shared model and the seats it occupies. */
export interface TwinGroup {
  modelId: string;
  /** 0-based seat indexes, ascending. */
  seats: number[];
}

/** One model and the rubric sides it plays for. */
export interface MirrorGroup {
  modelId: string;
  /** 0-based team indexes, ascending. */
  sides: number[];
}

export interface RosterTwins {
  /** modelId → every seat holding it. Unfilled seats are skipped. */
  byModel: Map<string, number[]>;
  /** Per seat: the *other* seats holding the same model, or `null` when unique. */
  marks: Array<number[] | null>;
  /** Models held by more than one seat, in first-seat order. */
  groups: TwinGroup[];
}

/** modelId → 0-based seat indexes. Empty / missing slots are ignored. */
export function seatsByModel(modelIds: ReadonlyArray<string | null | undefined>): Map<string, number[]> {
  const byModel = new Map<string, number[]>();
  modelIds.forEach((id, index) => {
    if (!id) return;
    const seats = byModel.get(id);
    if (seats) seats.push(index);
    else byModel.set(id, [index]);
  });
  return byModel;
}

/**
 * Per seat: the other seats holding the same model, or `null`.
 *
 * An unfilled seat is always `null` — "还没选" is not a duplicate.
 */
function marksFrom(
  byModel: Map<string, number[]>,
  modelIds: ReadonlyArray<string | null | undefined>,
): Array<number[] | null> {
  return modelIds.map((id, index) => {
    if (!id) return null;
    const seats = byModel.get(id);
    if (!seats || seats.length < 2) return null;
    return seats.filter((seat) => seat !== index);
  });
}

/** Per-seat duplicate marks, for callers that do not need the whole roster view. */
export function duplicateMarks(
  modelIds: ReadonlyArray<string | null | undefined>,
): Array<number[] | null> {
  return marksFrom(seatsByModel(modelIds), modelIds);
}

/** Everything the launcher prints about a possibly-mirrored roster, in one pass. */
export function rosterTwins(modelIds: ReadonlyArray<string | null | undefined>): RosterTwins {
  const byModel = seatsByModel(modelIds);
  const groups: TwinGroup[] = [];
  for (const [modelId, seats] of byModel) if (seats.length > 1) groups.push({ modelId, seats });
  return { byModel, marks: marksFrom(byModel, modelIds), groups };
}

/**
 * Models that appear on more than one side of a rubric roster (a mirror duel).
 * A model repeated inside one side is not a mirror — it is that side repeating
 * itself, which the team card calls out separately.
 */
export function mirrorSides(teams: ReadonlyArray<{ modelIds: string[] }>): MirrorGroup[] {
  const byModel = new Map<string, number[]>();
  teams.forEach((team, side) => {
    for (const modelId of team.modelIds) {
      const sides = byModel.get(modelId) ?? [];
      if (!sides.includes(side)) sides.push(side);
      byModel.set(modelId, sides);
    }
  });
  const groups: MirrorGroup[] = [];
  for (const [modelId, sides] of byModel) if (sides.length > 1) groups.push({ modelId, sides });
  return groups;
}

/** "#3、#7" — 1-based seat numbers for the labels. */
export function seatList(seats: readonly number[]): string {
  return seats.map((seat) => `#${seat + 1}`).join("、");
}
