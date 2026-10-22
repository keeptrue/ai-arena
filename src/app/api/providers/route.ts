import { ensureSeedData, listProviders, upsertProvider } from "@/db/repo";
import { getSecret, maskedSecrets, setSecret } from "@/lib/secrets";
import type { ProviderKind } from "@/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS: ProviderKind[] = ["openai", "anthropic", "gemini", "mock"];

export async function GET() {
  ensureSeedData();
  return Response.json({ providers: listProviders(), secrets: maskedSecrets() });
}

export async function POST(req: Request) {
  ensureSeedData();
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    kind?: ProviderKind;
    baseUrl?: string;
    apiKey?: string;
    enabled?: boolean;
  };
  if (!body.name?.trim()) return Response.json({ error: "缺少名称" }, { status: 400 });
  if (!body.kind || !KINDS.includes(body.kind)) {
    return Response.json({ error: `类型必须是 ${KINDS.join(" / ")}` }, { status: 400 });
  }
  if (!body.baseUrl?.trim()) return Response.json({ error: "缺少 base URL" }, { status: 400 });

  const id = upsertProvider({
    id: body.id,
    name: body.name.trim(),
    kind: body.kind,
    baseUrl: body.baseUrl.trim(),
    enabled: body.enabled,
  });
  if (typeof body.apiKey === "string") setSecret(id, body.apiKey);
  return Response.json({ id, hasKey: !!getSecret(id), secrets: maskedSecrets() });
}
