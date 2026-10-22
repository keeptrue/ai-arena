import { deleteProvider } from "@/db/repo";
import { setSecret } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteProvider(id);
  setSecret(id, "");
  return Response.json({ ok: true });
}
