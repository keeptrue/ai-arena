import { ensureSeedData, getMatch } from "@/db/repo";
import { startWerewolfReview } from "@/engine/werewolf/review-runtime";
import { startCoupReview } from "@/engine/coup/review-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/matches/[id]/review
 *
 * Arms the post-game review and returns immediately: ballots arrive as events on
 * the match stream. `{ force: true }` re-runs a review that already has a verdict
 * (or one whose match was aborted).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureSeedData();
  const body = (await req.json().catch(() => ({}))) as { force?: unknown };
  const match = getMatch(id);
  if (match?.kind === "coup") {
    const coup = await startCoupReview(id, { trigger: "manual" });
    return Response.json(coup, { status: coup.ok ? 202 : 409 });
  }
  const result = await startWerewolfReview(id, { trigger: "manual", force: body.force === true });
  const status =
    result.ok && result.status === "running"
      ? 202
      : result.status === "already"
        ? 200
        : result.status === "not_found"
          ? 404
          : 409;
  return Response.json(result, { status });
}
