/** Local smoke test: nine rehearsal models, one real match through the runtime. */

import { getWerewolfContext, startWerewolfMatch } from "../src/engine/werewolf/runtime";
import { reviewStatus } from "../src/engine/werewolf/review-runtime";
import type { WerewolfBlueprint } from "../src/engine/werewolf/types";
import {
  ensureSeedData,
  eventsAfter,
  getRulesetBySlug,
  listModels,
  syncProviderModels,
  upsertProvider,
} from "../src/db/repo";
import { syncBuiltinRulesets } from "../src/lib/rulesets";
import { listRemoteModels } from "../src/providers/list-models";

ensureSeedData();
await syncBuiltinRulesets();

const ruleset = getRulesetBySlug("werewolf-nine");
if (!ruleset) throw new Error("werewolf-nine 规则没有同步进来");
if (ruleset.blueprint.mode !== "werewolf") throw new Error("规则不是九人局");
const spec = ruleset.blueprint as WerewolfBlueprint;

// The local rehearsal provider may be absent from an existing install; the smoke
// script creates it explicitly so no real key is touched.
const mockId = upsertProvider({
  id: "mock",
  name: "演练场（本地，无需 Key）",
  kind: "mock",
  baseUrl: "local://mock",
});
const remote = await listRemoteModels({ kind: "mock", baseUrl: "local://mock", apiKey: "" });
syncProviderModels(mockId, remote);
const seats = listModels()
  .filter((m) => m.providerId === mockId && m.enabled && m.inContenderPool)
  .slice(0, 9)
  .map((m) => ({ modelId: m.id }));
if (seats.length !== 9) throw new Error(`演练体不足：${seats.length}`);

const result = await startWerewolfMatch({
  ruleset,
  spec,
  seats,
  deal: { mode: "engine" },
  seed: process.argv[2] ?? "werewolf-smoke",
});

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const ctx = getWerewolfContext(result.matchId);
  if (!ctx || ctx.state.phase === "done") break;
  await new Promise((r) => setTimeout(r, 200));
}

const ctx = getWerewolfContext(result.matchId);
const events = eventsAfter(result.matchId, 0);

// The review is fire-and-forget after the last vote; the smoke test waits for the
// verdict so one command covers "game + ten ballots + one ranking".
const reviewDeadline = Date.now() + 120_000;
let review = reviewStatus(result.matchId);
while (Date.now() < reviewDeadline) {
  if (review.verdict || (!review.live && !review.resumable)) break;
  await new Promise((r) => setTimeout(r, 500));
  review = reviewStatus(result.matchId);
}

console.log(
  JSON.stringify(
    {
      matchId: result.matchId,
      phase: ctx?.state.phase,
      day: ctx?.state.day,
      winner: ctx?.state.winner,
      reason: ctx?.state.endReason,
      calls: ctx?.state.budget.calls,
      events: events.length,
      review: {
        attempt: review.attempt,
        live: review.live,
        resumable: review.resumable,
        hasVerdict: !!review.verdict,
        ranking: review.verdict?.ranking.length ?? 0,
        players: review.verdict?.raters.players ?? 0,
        judge: review.verdict?.judge ?? false,
        top: review.verdict?.ranking[0] ?? null,
      },
      last: events.slice(-3).map((e) => e.type),
    },
    null,
    2,
  ),
);
process.exit(ctx?.state.phase === "done" && !!review.verdict ? 0 : 1);
