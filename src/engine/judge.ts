/**
 * Judge selection. Pure: no I/O, no randomness — the same candidates and the same
 * roster always name the same referee, so any match's choice can be explained.
 *
 * The caller decides *which* models are eligible (enabled, keyed, in the judge
 * pool); this module only decides which of them takes the chair.
 */

export interface JudgeCandidate {
  /** `models.id` — the row id the runtime snapshots. */
  id: string;
  providerId: string;
  /** Kept for call sites that want to name the loser in an error message. */
  display: string;
}

export type JudgePick =
  | { ok: true; modelId: string; reason: "explicit" | "independent" | "fallback" }
  | { ok: false; reason: "empty_pool" | "not_in_pool" };

/**
 * Explicit picks win outright. Otherwise prefer a provider that is not on the
 * roster — a model from the same vendor as a contender sheds doubt on the score —
 * and only when every candidate shares a provider fall back to the first one.
 *
 * Candidate order is the caller's order (`listModels()`), so the fallback is
 * deterministic across restarts.
 */
export function chooseJudge(
  candidates: readonly JudgeCandidate[],
  contenderProviderIds: readonly string[],
  preferredId?: string | null,
): JudgePick {
  const preferred = preferredId?.trim();
  if (preferred) {
    const hit = candidates.find((c) => c.id === preferred);
    return hit
      ? { ok: true, modelId: hit.id, reason: "explicit" }
      : { ok: false, reason: "not_in_pool" };
  }
  if (candidates.length === 0) return { ok: false, reason: "empty_pool" };

  const taken = new Set(contenderProviderIds);
  const independent = candidates.find((c) => !taken.has(c.providerId));
  if (independent) return { ok: true, modelId: independent.id, reason: "independent" };
  return { ok: true, modelId: candidates[0].id, reason: "fallback" };
}
