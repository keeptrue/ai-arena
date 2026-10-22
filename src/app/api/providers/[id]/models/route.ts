import { getProvider, listModels, syncProviderModels } from "@/db/repo";
import { getSecret } from "@/lib/secrets";
import { listRemoteModels } from "@/providers/list-models";
import { loadCatalog, lookupModelCard } from "@/providers/models-dev";
import type { ModelCard } from "@/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pulls the provider's live model catalogue and upserts it into the local pool. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) return Response.json({ error: "接入方不存在" }, { status: 404 });

  const apiKey = getSecret(provider.id);
  if (provider.kind !== "mock" && !apiKey) {
    return Response.json({ error: "这个接入方还没有 Key" }, { status: 400 });
  }

  try {
    const remote = await listRemoteModels({
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey,
    });
    // models.dev is optional enrichment: an unreachable catalogue must not fail the sync.
    const cards = new Map<string, ModelCard | null>();
    let enriched = 0;
    try {
      const catalog = await loadCatalog();
      for (const m of remote) {
        const card = lookupModelCard(catalog, {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          modelId: m.id,
        });
        cards.set(m.id, card);
        if (card) enriched += 1;
      }
    } catch {
      /* keep going with provider-only data */
    }

    syncProviderModels(provider.id, remote, cards);
    return Response.json({
      ok: true,
      count: remote.length,
      enriched,
      models: listModels().filter((m) => m.providerId === provider.id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      /HTTP 401|HTTP 403/.test(message)
        ? "Key 可能不对"
        : /HTTP 404/.test(message)
          ? "base URL 可能少了 /v1，或该端点不支持列模型"
          : /fetch failed|ENOTFOUND|ECONNREFUSED/.test(message)
            ? "域名或端口不可达"
            : null;
    return Response.json({ error: hint ? `${message}（${hint}）` : message }, { status: 502 });
  }
}
