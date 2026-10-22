import { abortMatch } from "@/engine/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  abortMatch(id, "manual");
  return Response.json({ ok: true });
}
