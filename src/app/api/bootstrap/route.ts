import { ensureRuntime } from "@/engine/runtime";
import { ensureSeedData, listModels, listProviders, listRulesets } from "@/db/repo";
import { blueprintMeta, isRubricBlueprint } from "@/engine/game";
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
    rulesets: listRulesets().map((r) => {
      const bp = r.blueprint;
      const meta = blueprintMeta(bp);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        kind: meta.kind,
        rounds: meta.rounds,
        seats: meta.seats,
        tagline: bp.tagline,
        dimensions: isRubricBlueprint(bp) ? bp.rubric.dimensions : [],
        slots: isRubricBlueprint(bp) ? bp.submission.slots : [],
        enabled: r.enabled,
      };
    }),
    secrets: maskedSecrets(),
  });
}
