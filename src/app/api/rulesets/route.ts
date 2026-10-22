import { ensureSeedData, listRulesets, upsertRuleset } from "@/db/repo";
import { hashBlueprint, parseBlueprint } from "@/engine/blueprint";
import { syncBuiltinRulesets } from "@/lib/rulesets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureSeedData();
  await syncBuiltinRulesets();
  return Response.json({ rulesets: listRulesets() });
}

export async function POST(req: Request) {
  ensureSeedData();
  const body = (await req.json().catch(() => ({}))) as {
    slug?: string;
    name?: string;
    sourceMd?: string;
    blueprint?: unknown;
  };
  if (!body.slug || !/^[a-z0-9][a-z0-9-]*$/.test(body.slug)) {
    return Response.json({ error: "slug 只能是小写字母/数字/连字符" }, { status: 400 });
  }
  try {
    const blueprint = parseBlueprint(body.blueprint);
    const id = upsertRuleset({
      slug: body.slug,
      name: body.name?.trim() || blueprint.name,
      sourceMd: body.sourceMd ?? "",
      blueprint,
      blueprintHash: hashBlueprint(blueprint),
      compiledAt: Date.now(),
      compiledBy: "manual",
    });
    return Response.json({ id, rulesets: listRulesets() }, { status: 201 });
  } catch (err) {
    const issues = (err as { issues?: string[] }).issues;
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), issues: issues ?? [] },
      { status: 400 },
    );
  }
}
