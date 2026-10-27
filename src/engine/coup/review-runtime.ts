/**
 * Coup post-game review: the side-effecting half.
 *
 * Runs after `finish` as an independent pipeline: it never writes the game state,
 * never touches the checkpoint, and never consumes the match budget. A failure here
 * leaves the match finished — a table that cannot be scored is still a finished table.
 */

import { appendEvent, getMatch, getMatchRoster, listModels, loadCheckpoint, nextSeq, snapshotModel } from "@/db/repo";
import { publish } from "@/lib/bus";
import { getSecret } from "@/lib/secrets";
import { callWithRetry } from "@/providers";
import { chooseJudge } from "../judge";
import type { ArenaEvent, ModelSnapshot } from "../types";
import {
  aggregateCoupReview,
  buildCoupBallotPrompt,
  collectCoupFacts,
  parseCoupBallot,
  resolveCoupReviewRules,
  type CoupBallotRow,
  type CoupReviewBallot,
} from "./review";
import type { CoupState } from "./types";

export type CoupReviewTrigger = "auto" | "manual";

interface ReviewCtx {
  matchId: string;
  state: CoupState;
  seq: number;
}

const MAX_CONCURRENCY = 2;

export async function startCoupReview(
  matchId: string,
  input: { trigger: CoupReviewTrigger; state?: CoupState },
): Promise<{ ok: boolean; ballots: number; error?: string }> {
  const match = getMatch(matchId);
  if (!match) return { ok: false, ballots: 0, error: "not_found" };
  const roster = getMatchRoster(matchId);
  const state = input.state ?? readTerminalState(matchId);
  if (!state) return { ok: false, ballots: 0, error: "no_state" };

  const rules = resolveCoupReviewRules(state.spec);
  if (!rules.enabled) return { ok: false, ballots: 0, error: "disabled" };

  const facts = collectCoupFacts(state);
  const ctx: ReviewCtx = { matchId, state, seq: nextSeq(matchId) };

  const keyed = new Set(
    listModels()
      .filter((m) => m.enabled)
      .map((m) => `${m.providerId}/${m.modelId}`),
  );
  void keyed;

  const judge = pickJudge(roster.participants.map((p) => p.model.providerId));
  const raters: Array<{ id: number | "judge"; model: ModelSnapshot }> = roster.participants.map((p) => ({
    id: p.seat,
    model: p.model,
  }));
  if (judge) raters.push({ id: "judge", model: judge });

  emit(ctx, {
    type: "review.opened",
    ts: Date.now(),
    payload: {
      kind: "coup",
      trigger: input.trigger,
      raters: raters.map((r) => ({ rater: r.id, display: r.model.display })),
      judge: judge ? { display: judge.display } : null,
      dimensions: ["bluff", "read", "tempo", "poise"],
      weights: rules.weights,
    },
  });

  const ballots: CoupReviewBallot[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, raters.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= raters.length) return;
      const rater = raters[index];
      const ballot = await runBallot({ ctx, rater, facts, rules });
      if (ballot) ballots.push(ballot);
    }
  });
  await Promise.all(workers);

  const verdict = aggregateCoupReview({ ballots, rules });
  emit(ctx, {
    type: "review.verdict",
    ts: Date.now(),
    payload: {
      kind: "coup",
      champion: verdict.champion,
      provisional: verdict.provisional,
      seats: verdict.seats.map((s) => ({
        seat: s.seat,
        total: s.total,
        dimensions: s.dimensions,
        ballots: s.ballots,
        selfTotal: s.selfTotal,
        notes: s.notes.slice(0, 3),
      })),
      bestBluff: verdict.bestBluff,
      bestRead: verdict.bestRead,
    },
  });

  return { ok: true, ballots: ballots.length };
}

async function runBallot(input: {
  ctx: ReviewCtx;
  rater: { id: number | "judge"; model: ModelSnapshot };
  facts: ReturnType<typeof collectCoupFacts>;
  rules: ReturnType<typeof resolveCoupReviewRules>;
}): Promise<CoupReviewBallot | null> {
  const { ctx, rater, facts, rules } = input;
  const apiKey = getSecret(rater.model.providerId);
  if (!apiKey && rater.model.kind !== "mock") return null;

  const prompt = buildCoupBallotPrompt({ facts, raterSeat: rater.id, rules });
  try {
    const result = await callWithRetry(
      {
        model: { ...rater.model, temperature: 0 },
        apiKey,
        system: prompt.system,
        messages: prompt.messages,
        json: true,
        ...(Number.isFinite(180_000) ? { signal: AbortSignal.timeout(180_000) } : {}),
      },
      () => {},
    );
    const parsed = parseCoupBallot(result.text);
    if (!parsed) {
      emit(ctx, {
        type: "anomaly",
        ts: Date.now(),
        payload: { code: "review_parse_failed", rater: rater.id },
      });
      return null;
    }
    emit(ctx, {
      type: "review.ballot",
      ts: Date.now(),
      payload: { kind: "coup", rater: rater.id, rows: parsed.rows },
    });
    return { rater: rater.id, rows: parsed.rows as CoupBallotRow[] };
  } catch (err) {
    emit(ctx, {
      type: "anomaly",
      ts: Date.now(),
      payload: {
        code: "review_call_failed",
        rater: rater.id,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

function pickJudge(contenderProviders: string[]): ModelSnapshot | null {
  const candidates = listModels()
    .filter((m) => m.enabled && m.inJudgePool)
    .map((m) => ({ id: m.id, providerId: m.providerId, display: m.display }));
  const pick = chooseJudge(candidates, contenderProviders, null);
  if (!pick.ok) return null;
  try {
    return snapshotModel(pick.modelId);
  } catch {
    return null;
  }
}

/** The terminal checkpoint written by `finishNow`; the review never re-simulates. */
function readTerminalState(matchId: string): CoupState | null {
  const checkpoint = loadCheckpoint(matchId);
  if (!checkpoint || checkpoint.kind !== "coup") return null;
  const payload = checkpoint.payload as { state?: CoupState } | null;
  return payload?.state ?? null;
}

function emit(ctx: ReviewCtx, partial: Omit<ArenaEvent, "seq">): void {
  const event: ArenaEvent = { seq: ctx.seq++, ...partial };
  appendEvent(ctx.matchId, event);
  publish(ctx.matchId, event);
}
