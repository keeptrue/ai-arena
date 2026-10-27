/**
 * Creates the schema, seeds providers/personas/rehearsal models, and syncs the
 * built-in rulesets. Safe to run repeatedly.
 *
 *   bun run db:migrate
 */

import { ensureSeedData, listModels, listProviders, listRulesets } from "../src/db/repo";
import { syncBuiltinRulesets } from "../src/lib/rulesets";

ensureSeedData();
const { synced, errors } = await syncBuiltinRulesets();

console.log(`providers : ${listProviders().length}`);
console.log(`models    : ${listModels().length}`);
console.log(`rulesets  : ${listRulesets().map((r) => `${r.slug}(${r.blueprint.mode === "werewolf" || r.blueprint.mode === "coup" ? `${r.blueprint.seats}人` : `${r.blueprint.rounds}轮`})`).join(", ") || "none"}`);
if (synced.length) console.log(`synced    : ${synced.join(", ")}`);
for (const e of errors) console.error(`! ${e}`);
