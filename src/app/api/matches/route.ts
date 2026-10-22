import { ensureRuntime, startMatch } from "@/engine/runtime";
import { ensureSeedData, listMatches } from "@/db/repo";
import { syncBuiltinRulesets } from "@/lib/rulesets";
import type { StartOptions } from "@/engine/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  ensureRuntime();
  ensureSeedData();
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "40");
  return Response.json({ matches: listMatches(Number.isFinite(limit) ? limit : 40) });
}

export async function POST(req: Request) {
  ensureRuntime();
  ensureSeedData();
  await syncBuiltinRulesets();
  const body = (await req.json().catch(() => ({}))) as StartOptions;
  try {
    const result = await startMatch(body);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
