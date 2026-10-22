/**
 * OpenAI-compatible chat completions.
 * Covers DeepSeek, Moonshot, OpenRouter, Ollama, vLLM, LM Studio and anything else
 * that speaks /v1/chat/completions.
 */

import type { CallRequest, CallResult, DeltaSink, ProviderAdapter } from "./types";
import { assertOk, readSse } from "./sse";
import { openAiReasoningBody } from "./reasoning";

interface OaiDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}
interface OaiChunk {
  choices?: Array<{ delta?: OaiDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export const openaiCompat: ProviderAdapter = {
  kind: "openai",
  async call(req: CallRequest, onDelta: DeltaSink): Promise<CallResult> {
    const started = Date.now();
    const cap = req.maxTokens;
    const body: Record<string, unknown> = {
      model: req.model.modelId,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      stream: true,
      stream_options: { include_usage: true },
    };
    // 输出不设上限: the reasoning channel shares the completion window, so any
    // ceiling we send is a ceiling the visible answer might never reach.
    // Only an explicit caller-supplied cap is forwarded.
    if (typeof cap === "number" && cap > 0) body.max_tokens = cap;
    // Reasoning models such as GPT-5 reject a temperature outright.
    if (req.model.supportsTemperature !== false) {
      body.temperature = req.temperature ?? req.model.temperature;
    }
    if (req.json) body.response_format = { type: "json_object" };
    // Reasoning strength is model config, not call config: the snapshot carries it.
    Object.assign(body, openAiReasoningBody(req.model));

    const res = await fetch(joinUrl(req.model.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.apiKey}`,
      },
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
      let chunk: OaiChunk;
      try {
        chunk = JSON.parse(data) as OaiChunk;
      } catch {
        return;
      }
      if (chunk.error?.message) {
        streamError = chunk.error.message;
        return;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        // DeepSeek uses reasoning_content; OpenRouter uses reasoning.
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === "string" && r.length > 0) {
          thinking += r;
          onDelta({ thinking: r });
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          text += delta.content;
          onDelta({ text: delta.content });
        }
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
    });

    if (streamError) throw new Error(`${req.model.providerName}: ${streamError}`);
    if (!text && !thinking) throw new Error(`${req.model.providerName}: empty stream`);

    return {
      text,
      thinking,
      usage: {
        promptTokens: promptTokens || estimateTokens(req.system + req.messages.map((m) => m.content).join("")),
        completionTokens: completionTokens || estimateTokens(text + thinking),
      },
      latencyMs: Date.now() - started,
    };
  },
};

/** Rough fallback when a gateway omits usage entirely. */
export function estimateTokens(text: string): number {
  // CJK ≈ 1 token per 1.6 chars, latin ≈ 1 per 4 chars. Blended conservative rate:
  return Math.max(1, Math.ceil(text.length / 2.6));
}
