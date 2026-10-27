import { intervene } from "@/engine/runtime";
import type { InterventionKind } from "@/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS: InterventionKind[] = ["pause", "resume", "say", "rule", "score", "forfeit", "recall"];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    kind?: InterventionKind;
    text?: string;
    teamId?: string;
    participantId?: string;
    seat?: number;
    delta?: number;
  };
  if (!body.kind || !KINDS.includes(body.kind)) {
    return Response.json({ error: `kind 必须是 ${KINDS.join(" / ")}` }, { status: 400 });
  }
  const result = intervene(id, {
    kind: body.kind,
    text: body.text,
    teamId: body.teamId,
    participantId: body.participantId,
    seat: body.seat,
    delta: body.delta,
  });
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
