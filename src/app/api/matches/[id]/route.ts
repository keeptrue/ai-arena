import { ensureSeedData, eventsAfter, getMatch, getMatchJudge, getMatchRoster, hasCheckpoint } from "@/db/repo";
import { isLive } from "@/engine/runtime";
import { reviewStatus } from "@/engine/werewolf/review-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The judge column only exists after v6, and this route can be the first DB touch
  // in a fresh process — seed/migrate before reading it.
  ensureSeedData();
  const match = getMatch(id);
  if (!match) return Response.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  const rawAfter = Number(url.searchParams.get("after") ?? 0);
  const rawLimit = Number(url.searchParams.get("limit") ?? 20000);
  const after = Number.isFinite(rawAfter) && rawAfter >= 0 ? Math.floor(rawAfter) : 0;
  const limit = Number.isFinite(rawLimit) ? Math.min(50000, Math.max(1, Math.floor(rawLimit))) : 20000;
  // Fetch one extra row so the client can tell whether another page exists.
  const rows = eventsAfter(id, after, limit + 1);
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  // `live` answers "is anything driving this match right now"; `resumable` answers
  // "did it die mid-flight with a checkpoint to rewind to". The table needs both to
  // tell a finished match from an orphan.
  const live = isLive(id);
  const resumable =
    !live && hasCheckpoint(id) && (match.status === "running" || match.status === "interrupted");
  // The post-game review has its own liveness: it outlives the match ctx and is
  // driven by its own loop, so the table cannot infer "评分中" from `live`.
  return Response.json({
    match,
    roster: getMatchRoster(id),
    judge: getMatchJudge(id),
    events,
    hasMore,
    nextAfter: events.length ? events[events.length - 1].seq : after,
    live,
    resumable,
    review: reviewStatus(id),
  });
}
