/** Anthropic Messages API with optional extended thinking. */

import type { CallRequest, CallResult, DeltaSink, ProviderAdapter } from "./types";
import { assertOk, readSse } from "./sse";
import { anthropicThinkingPlan } from "./reasoning";

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  message?: { usage?: AnthropicUsage };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/**
 * Anthropic reports the cached slice **outside** `input_tokens`, unlike every other
 * vendor. The adapter folds all three back together so `promptTokens` keeps meaning
 * "total input the model read" everywhere downstream.
 */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Below this the API cannot cache at all (1024 tokens on Sonnet-class models). */
const CACHE_MIN_PREFIX_CHARS = 2_800;

/** `max_tokens` is mandatory on the Messages API; this is what "no cap" sends. */
export const ANTHROPIC_UNLIMITED_MAX_OUTPUT = 64_000;
/** Older Claude models cap output at 8k; fall back here when the big number is rejected. */
export const ANTHROPIC_FALLBACK_MAX_OUTPUT = 8_192;

/** Chars from the start of the turn list to the deepest marked breakpoint, or null. */
function stablePrefixChars(req: CallRequest): number | null {
  let chars = 0;
  let cut: number | null = null;
  for (const message of req.messages) {
    chars += message.content.length;
    if (typeof message.cacheAt === "number" && message.cacheAt > 0) {
      cut = chars - message.content.length + Math.min(message.cacheAt, message.content.length);
    }
  }
  return cut;
}

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

    // Where the stable prefix ends. `null` = the caller marked nothing, so this
    // request has no reusable head and we send plain strings.
    const cacheCut = stablePrefixChars(req);
    const cacheMode = req.model.providerCacheMode ?? "explicit";
    const useCache =
      cacheMode !== "none" && cacheCut !== null && req.system.length + cacheCut >= CACHE_MIN_PREFIX_CHARS;

    const systemWire = () =>
      useCache
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system;

    const messagesWire = () =>
      req.messages.map((m) => {
        const cut = m.cacheAt;
        // Anthropic concatenates adjacent text blocks, so splitting is invisible to
        // the model — it only tells the cache where the reusable prefix stops.
        if (!useCache || typeof cut !== "number" || cut <= 0 || cut >= m.content.length) {
          return { role: m.role, content: m.content };
        }
        return {
          role: m.role,
          content: [
            { type: "text", text: m.content.slice(0, cut), cache_control: { type: "ephemeral" } },
            { type: "text", text: m.content.slice(cut) },
          ],
        };
      });

    const buildBody = (maxTokens: number) => {
      // Anthropic rejects budget_tokens >= max_tokens, so the plan degrades to null
      // whenever the configured strength cannot fit inside the output window.
      const plan = anthropicThinkingPlan(req.model, maxTokens);
      const body: Record<string, unknown> = {
        model: req.model.modelId,
        max_tokens: maxTokens,
        system: systemWire(),
        messages: messagesWire(),
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
    let cachedPromptTokens = 0;
    let cacheWriteTokens = 0;
    let streamError: string | null = null;

    await readSse(res.body, (data) => {
      if (data === "[DONE]") return;
      // `ping` and `message_delta` carry no content but do prove the stream lives.
      req.onBeat?.();
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
        const usage = ev.message.usage;
        cachedPromptTokens = usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
        // Cached and cache-writing tokens sit outside `input_tokens`; add them back
        // so `promptTokens` stays "everything the model read".
        promptTokens = (usage.input_tokens ?? 0) + cachedPromptTokens + cacheWriteTokens;
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
    }, req.onBeat);

    if (streamError) throw new Error(`${req.model.providerName}: ${streamError}`);
    return {
      text,
      thinking,
      usage: { promptTokens, completionTokens, cachedPromptTokens, cacheWriteTokens },
      latencyMs: Date.now() - started,
    };
  },
};
