import { ensureRuntime } from "@/engine/runtime";
import { ensureSeedData, listModels, listProviders, listRulesets } from "@/db/repo";
import { maskedSecrets } from "@/lib/secrets";
import { syncBuiltinRulesets } from "@/lib/rulesets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureRuntime();
  ensureSeedData();
  await syncBuiltinRulesets();
  return Response.json({
    providers: listProviders(),
    models: listModels(),
    rulesets: listRulesets().map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      rounds: r.blueprint.rounds,
      tagline: r.blueprint.tagline,
      dimensions: r.blueprint.rubric.dimensions,
      slots: r.blueprint.submission.slots,
      enabled: r.enabled,
    })),
    secrets: maskedSecrets(),
  });
}
