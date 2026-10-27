/**
 * Lineup restore helpers. Pure: no I/O, no React, no database.
 *
 * A past match freezes its roster as `ModelSnapshot`s (provider row + provider
 * model string). The launcher needs current `models.id` values, so this module
 * maps a record back onto whatever sits in the contender pool right now and says
 * plainly which seats no longer resolve.
 */

/** One seat as frozen in `participants.model_json`. */
export interface LineupSeat {
  providerId: string;
  modelId: string;
  /** Display name at match time; only used when the seat no longer resolves. */
  display: string;
}

export interface LineupTeam {
  name: string;
  color: string;
  seats: LineupSeat[];
}

/** One past match, reduced to what the roster section needs. */
export interface LineupRecord {
  matchId: string;
  createdAt: number;
  /** Werewolf tables are not offered as a rubric roster. */
  kind?: "rubric" | "werewolf" | "coup";
  teams: LineupTeam[];
}

/** A currently selectable model, keyed the same way a snapshot is. */
export interface LineupPoolModel {
  id: string;
  providerId: string;
  modelId: string;
  display: string;
}

export interface LineupTeamView {
  name: string;
  color: string;
  modelIds: string[];
  /** Snapshot display names for seats that no longer resolve. */
  missing: string[];
}

export interface LineupIssue {
  code: "model_missing" | "roster_invalid";
  detail?: string;
}

export interface ResolvedLineup {
  matchId: string;
  createdAt: number;
  kind?: "rubric" | "werewolf" | "coup";
  /** Snapshot identity of the roster, used to fold repeated lineups together. */
  signature: string;
  teams: LineupTeamView[];
  usable: boolean;
  issues: LineupIssue[];
}

function signatureOf(record: LineupRecord): string {
  return record.teams
    .map((t) => t.seats.map((s) => `${s.providerId}/${s.modelId}`).join(","))
    .join("|");
}

export function resolveLineup(record: LineupRecord, pool: LineupPoolModel[]): ResolvedLineup {
  const index = new Map<string, Map<string, string>>();
  for (const m of pool) {
    const byModel = index.get(m.providerId) ?? new Map<string, string>();
    byModel.set(m.modelId, m.id);
    index.set(m.providerId, byModel);
  }

  const issues: LineupIssue[] = [];
  const teams: LineupTeamView[] = record.teams.map((team) => {
    const modelIds: string[] = [];
    const missing: string[] = [];
    for (const seat of team.seats) {
      const id = index.get(seat.providerId)?.get(seat.modelId);
      if (id) modelIds.push(id);
      else missing.push(seat.display);
    }
    if (team.seats.length === 0) {
      issues.push({ code: "roster_invalid", detail: team.name });
    }
    for (const display of missing) {
      issues.push({ code: "model_missing", detail: display });
    }
    return { name: team.name, color: team.color, modelIds, missing };
  });

  if (teams.length < 2) issues.push({ code: "roster_invalid" });

  return {
    matchId: record.matchId,
    createdAt: record.createdAt,
    kind: record.kind,
    signature: signatureOf(record),
    teams,
    usable: issues.length === 0,
    issues,
  };
}

/**
 * The roster the card should offer: the newest match when it still resolves,
 * otherwise the newest *different* roster that does. `latest` is kept so the UI
 * can explain why it skipped ahead instead of silently showing an older match.
 */
export function pickLineups(
  records: LineupRecord[],
  pool: LineupPoolModel[],
): { latest: ResolvedLineup | null; restorable: ResolvedLineup | null } {
  const resolved = records
    .filter((r) => r.kind !== "werewolf" && r.kind !== "coup")
    .map((r) => resolveLineup(r, pool));
  const latest = resolved[0] ?? null;
  if (!latest) return { latest: null, restorable: null };
  if (latest.usable) return { latest, restorable: latest };

  const seen = new Set([latest.signature]);
  for (const candidate of resolved.slice(1)) {
    if (seen.has(candidate.signature)) continue;
    seen.add(candidate.signature);
    if (candidate.usable) return { latest, restorable: candidate };
  }
  return { latest, restorable: null };
}
