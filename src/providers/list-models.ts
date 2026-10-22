/** Fetch the model catalogue a provider actually exposes, normalised. */

import type { ProviderKind } from "@/engine/types";
import { assertOk } from "./sse";

export interface RemoteModel {
  id: string;
  display: string;
  contextWindow?: number | null;
}

export async function listRemoteModels(input: {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
}): Promise<RemoteModel[]> {
  const base = input.baseUrl.replace(/\/+$/, "");

  if (input.kind === "mock") {
    return [
      { id: "rehearsal-a", display: "演练体 A" },
      { id: "rehearsal-b", display: "演练体 B" },
      { id: "rehearsal-c", display: "演练体 C" },
      { id: "rehearsal-d", display: "演练体 D" },
    ];
  }

  if (input.kind === "openai") {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
    });
    await assertOk(res, "OpenAI 兼容端点");
    const json = (await res.json()) as { data?: Array<{ id?: string; name?: string; context_length?: number }> };
    const rows = json.data ?? [];
    return rows
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id!, display: m.name ?? m.id!, contextWindow: m.context_length ?? null }));
  }

  if (input.kind === "anthropic") {
    const res = await fetch(`${base}/v1/models?limit=100`, {
      headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
    });
    await assertOk(res, "Anthropic");
    const json = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
    };
    return (json.data ?? [])
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id!, display: m.display_name ?? m.id! }));
  }

  // gemini
  const res = await fetch(`${base}/v1beta/models?pageSize=200&key=${encodeURIComponent(input.apiKey)}`);
  await assertOk(res, "Gemini");
  const json = (await res.json()) as {
    models?: Array<{
      name?: string;
      displayName?: string;
      inputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }>;
  };
  return (json.models ?? [])
    .filter((m) => {
      const id = m.name?.replace(/^models\//, "");
      if (!id) return false;
      const methods = m.supportedGenerationMethods ?? [];
      return methods.length === 0 || methods.includes("generateContent");
    })
    .map((m) => ({
      id: m.name!.replace(/^models\//, ""),
      display: m.displayName ?? m.name!.replace(/^models\//, ""),
      contextWindow: m.inputTokenLimit ?? null,
    }));
}
