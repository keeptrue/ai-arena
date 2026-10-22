import { ensureSeedData, eventsAfter, getMatch, getMatchJudge, getMatchRoster } from "@/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The judge column only exists after v6, and this route can be the first DB touch
  // in a fresh process — seed/migrate before reading it.
  ensureSeedData();
  const match = getMatch(id);
  if (!match) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    match,
    roster: getMatchRoster(id),
    judge: getMatchJudge(id),
    events: eventsAfter(id, 0),
  });
}
