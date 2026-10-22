/** Anthropic Messages API with optional extended thinking. */

import type { CallRequest, CallResult, DeltaSink, ProviderAdapter } from "./types";
import { assertOk, readSse } from "./sse";
import { anthropicThinkingPlan } from "./reasoning";

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/** `max_tokens` is mandatory on the Messages API; this is what "no cap" sends. */
export const ANTHROPIC_UNLIMITED_MAX_OUTPUT = 64_000;
/** Older Claude models cap output at 8k; fall back here when the big number is rejected. */
export const ANTHROPIC_FALLBACK_MAX_OUTPUT = 8_192;

export const anthropic: ProviderAdapter = {
  kind: "anthropic",
  async call(req: CallRequest, onDelta: DeltaSink): Promise<CallResult> {
    const started = Date.now();
    // 输出不设上限: `max_tokens` is mandatory here, so send the largest window we
    // know of. Older models reject it; the 400 path below retries with a
    // conservative window instead of failing the turn.
    const explicit =
      typeof req.maxTokens === "number" && req.maxTokens > 0 ? req.maxTokens : null;
    const unlimited = explicit === null;

    const buildBody = (maxTokens: number) => {
      // Anthropic rejects budget_tokens >= max_tokens, so the plan degrades to null
      // whenever the configured strength cannot fit inside the output window.
      const plan = anthropicThinkingPlan(req.model, maxTokens);
      const body: Record<string, unknown> = {
        model: req.model.modelId,
        max_tokens: maxTokens,
        system: req.system,
        messages: req.messages,
        stream: true,
      };
      if (plan) {
        // Anthropic requires temperature=1 (i.e. omitted) while thinking is on.
        body.thinking = { type: "enabled", budget_tokens: plan.budget_tokens };
      } else if (req.model.supportsTemperature !== false) {
        body.temperature = req.temperature ?? req.model.temperature;
      }
      return body;
    };

    const url = `${req.model.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const send = (maxTokens: number) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": req.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(buildBody(maxTokens)),
        signal: req.signal,
      });

    let res = await send(explicit ?? ANTHROPIC_UNLIMITED_MAX_OUTPUT);
    if (!res.ok && unlimited && res.status === 400) {
      const peek = await res
        .clone()
        .text()
        .catch(() => "");
      if (/max_tokens/i.test(peek)) res = await send(ANTHROPIC_FALLBACK_MAX_OUTPUT);
    }
    await assertOk(res, req.model.providerName);

    let text = "";
    let thinking = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let streamError: string | null = null;

    await readSse(res.body, (data) => {
      if (data === "[DONE]") return;
      let ev: AnthropicEvent;
      try {
        ev = JSON.parse(data) as AnthropicEvent;
      } catch {
        return;
      }
      if (ev.type === "error") {
        streamError = ev.error?.message ?? "anthropic stream error";
        return;
      }
      if (ev.type === "message_start" && ev.message?.usage) {
        promptTokens = ev.message.usage.input_tokens ?? 0;
      }
      if (ev.type === "content_block_delta" && ev.delta) {
        if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
          thinking += ev.delta.thinking;
          onDelta({ thinking: ev.delta.thinking });
        } else if (ev.delta.type === "text_delta" && ev.delta.text) {
          text += ev.delta.text;
          onDelta({ text: ev.delta.text });
        }
      }
      if (ev.type === "message_delta" && ev.usage) {
        completionTokens = ev.usage.output_tokens ?? completionTokens;
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
