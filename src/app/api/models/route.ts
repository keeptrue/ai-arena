import { ensureSeedData, getModelRow, listModels, updateModel } from "@/db/repo";
import { MAX_CALL_TIMEOUT_MS, MIN_CALL_TIMEOUT_MS } from "@/engine/runtime";
import { normalizeEffort, reconcileEffort, suggestedEffort } from "@/engine/reasoning";
import type { ModelCard, ProviderCacheMode, ReasoningEffort } from "@/engine/types";
import { fetchModelCard } from "@/providers/models-dev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureSeedData();
  return Response.json({ models: listModels() });
}

interface PatchBody {
  id?: string;
  display?: string;
  temperature?: number;
  supportsReasoning?: boolean;
  /** null / "" clears back to "provider default". */
  reasoningEffort?: ReasoningEffort | "" | null;
  /** Explicit thinking budget in tokens; null clears it. */
  thinkingBudget?: number | null;
  /** Per-model call ceiling in ms; null clears it back to the global default. */
  callTimeoutMs?: number | null;
  /** auto / explicit / none; null clears it back to "infer from the provider kind". */
  providerCacheMode?: ProviderCacheMode | "" | null;
  /** Pull the model card from models.dev and align reasoning support with it. */
  calibrate?: boolean;
  inContenderPool?: boolean;
  inJudgePool?: boolean;
  enabled?: boolean;
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as PatchBody;
  if (!body.id) return Response.json({ error: "缺少 id" }, { status: 400 });

  const row = getModelRow(body.id);
  if (!row) return Response.json({ error: "模型不存在" }, { status: 404 });

  const patch: Parameters<typeof updateModel>[1] = {};
  if (body.display !== undefined) patch.display = body.display;
  if (body.temperature !== undefined) patch.temperature = body.temperature;
  if (body.supportsReasoning !== undefined) patch.supportsReasoning = body.supportsReasoning;
  if (body.inContenderPool !== undefined) patch.inContenderPool = body.inContenderPool;
  if (body.inJudgePool !== undefined) patch.inJudgePool = body.inJudgePool;
  if (body.enabled !== undefined) patch.enabled = body.enabled;

  if (body.reasoningEffort !== undefined) {
    if (body.reasoningEffort === null || body.reasoningEffort === "") {
      patch.reasoningEffort = null;
    } else {
      const effort = normalizeEffort(body.reasoningEffort);
      if (!effort) {
        return Response.json(
          { error: `思考强度取值不认识：${String(body.reasoningEffort)}` },
          { status: 400 },
        );
      }
      patch.reasoningEffort = effort;
    }
  }

  if (body.providerCacheMode !== undefined) {
    if (body.providerCacheMode === null || body.providerCacheMode === "") {
      patch.providerCacheMode = null;
    } else if (body.providerCacheMode === "auto" || body.providerCacheMode === "explicit" || body.providerCacheMode === "none") {
      patch.providerCacheMode = body.providerCacheMode;
    } else {
      return Response.json(
        { error: `缓存模式取值不认识：${String(body.providerCacheMode)}` },
        { status: 400 },
      );
    }
  }

  if (body.thinkingBudget !== undefined) {
    if (body.thinkingBudget === null) {
      patch.thinkingBudget = null;
    } else {
      const budget = Math.floor(Number(body.thinkingBudget));
      if (!Number.isFinite(budget) || budget < 0 || budget > 200_000) {
        return Response.json({ error: "思考预算必须是 0–200000 的整数" }, { status: 400 });
      }
      patch.thinkingBudget = budget > 0 ? budget : null;
    }
  }

  if (body.callTimeoutMs !== undefined) {
    if (body.callTimeoutMs === null) {
      patch.callTimeoutMs = null;
    } else {
      const timeout = Math.floor(Number(body.callTimeoutMs));
      if (!Number.isFinite(timeout) || timeout < MIN_CALL_TIMEOUT_MS || timeout > MAX_CALL_TIMEOUT_MS) {
        return Response.json(
          { error: "思考时限必须是 1–120 分钟（60000–7200000 毫秒）" },
          { status: 400 },
        );
      }
      patch.callTimeoutMs = timeout;
    }
  }

  if (body.calibrate) {
    let card: ModelCard | null;
    try {
      card = await fetchModelCard({
        kind: row.providerKind,
        baseUrl: row.baseUrl,
        modelId: row.modelId,
      });
    } catch (err) {
      return Response.json(
        { error: `models.dev 不可达：${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }
    if (!card) {
      return Response.json({ error: `models.dev 里找不到 ${row.modelId}` }, { status: 404 });
    }
    patch.card = card;
    patch.supportsReasoning = card.reasoning;
    // Keep a still-valid choice; otherwise fall back to the catalogue's sensible default.
    patch.reasoningEffort = reconcileEffort(patch.reasoningEffort ?? row.reasoningEffort, card) ?? suggestedEffort(card);
    if (body.thinkingBudget === undefined && !card.options.some((o) => o.type === "budget_tokens")) {
      patch.thinkingBudget = null;
    }
  }

  updateModel(body.id, patch);
  return Response.json({ models: listModels() });
}
