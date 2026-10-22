/** Google Gemini generateContent (streaming, with thought parts). */

import type { CallRequest, CallResult, DeltaSink, ProviderAdapter } from "./types";
import { assertOk, readSse } from "./sse";
import { geminiThinkingConfig } from "./reasoning";

interface GeminiPart {
  text?: string;
  thought?: boolean;
}
interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

export const gemini: ProviderAdapter = {
  kind: "gemini",
  async call(req: CallRequest, onDelta: DeltaSink): Promise<CallResult> {
    const started = Date.now();
    const base = req.model.baseUrl.replace(/\/+$/, "");
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model.modelId)}:streamGenerateContent?alt=sse`;

    const thinkingConfig = geminiThinkingConfig(req.model);

    const cap = req.maxTokens;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        ...(req.model.supportsTemperature === false
          ? {}
          : { temperature: req.temperature ?? req.model.temperature }),
        // 输出不设上限: only an explicit caller-supplied cap is forwarded.
        ...(typeof cap === "number" && cap > 0 ? { maxOutputTokens: cap } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": req.apiKey },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    await assertOk(res, req.model.providerName);

    let text = "";
    let thinking = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let streamError: string | null = null;

    await readSse(res.body, (data) => {
      if (data === "[DONE]") return;
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(data) as GeminiChunk;
      } catch {
        return;
      }
      if (chunk.error?.message) {
        streamError = chunk.error.message;
        return;
      }
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text !== "string" || !p.text) continue;
        if (p.thought) {
          thinking += p.text;
          onDelta({ thinking: p.text });
        } else {
          text += p.text;
          onDelta({ text: p.text });
        }
      }
      if (chunk.usageMetadata) {
        promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
        completionTokens = chunk.usageMetadata.candidatesTokenCount ?? completionTokens;
      }
    });

    if (streamError) throw new Error(`${req.model.providerName}: ${streamError}`);
    return {
      text,
      thinking,
      usage: { promptTokens, completionTokens },
      latencyMs: Date.now() - started,
    };
  },
};
