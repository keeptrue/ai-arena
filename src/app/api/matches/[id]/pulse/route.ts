import { ensureSeedData, getMatchPulse, hasCheckpoint } from "@/db/repo";
import { isLive } from "@/engine/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Status ping for the pin in the header and for the table's reconnect check.
 * The arena SSE stream only exists on /arena/[id]; everywhere else this is how
 * the chip learns a match ended — or that its process died mid-flight.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same reasoning as the match route: this can be the first DB touch in a process.
  ensureSeedData();
  const pulse = getMatchPulse(id);
  if (!pulse) return Response.json({ error: "not found" }, { status: 404 });
  const live = isLive(id);
  const resumable =
    !live &&
    hasCheckpoint(id) &&
    (pulse.status === "running" || pulse.status === "interrupted");
  return Response.json({ ...pulse, live, resumable });
}
