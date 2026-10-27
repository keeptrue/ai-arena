import { ensureSeedData } from "@/db/repo";
import { recoverMatch, whenBooted } from "@/engine/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pick a match back up after the process died. Explicit on purpose: a recovery
 * spends real model calls, so it is an operator action, not a page side effect.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Wait for the orphan sweep before restarting: it must not land afterwards and
  // overwrite `running` with `interrupted`.
  await whenBooted();
  ensureSeedData();
  const { id } = await params;
  const result = recoverMatch(id);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
