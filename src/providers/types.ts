import type { ModelSnapshot, ProviderKind } from "@/engine/types";

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

/**
 * One conversation turn.
 *
 * `cache` marks the *end* of a stable prefix: everything up to and including this
 * message is byte-identical across the calls that share a lineage, so a provider
 * with explicit caching may store it and bill the rest at the cached rate.
 * Adapters that cache implicitly (DeepSeek, Gemini) simply ignore the flag.
 */
export interface CallMessage {
  role: "user" | "assistant";
  content: string;
  /**
   * Char offset where the reusable prefix ends (`content.slice(0, cacheAt)` plus the
   * system prompt). Providers with explicit caching split the message there and mark
   * a breakpoint; providers that match prefixes on their own just ignore it.
   */
  cacheAt?: number;
}

export interface CallRequest {
  model: ModelSnapshot;
  apiKey: string;
  system: string;
  messages: CallMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Ask the provider for a JSON object when it supports a native JSON mode. */
  json?: boolean;
  /**
   * Called on every byte that arrives, including keep-alive comments and frames
   * that carry no content. The runtime uses it to tell "the connection is alive
   * and the model is thinking" from "the stream is dead", which content deltas
   * alone cannot distinguish.
   */
  onBeat?: () => void;
}

export interface StreamDelta {
  /** Reasoning / thinking channel. Forwarded to the audience live. */
  thinking?: string;
  /** Visible answer channel. */
  text?: string;
}

/**
 * Token accounting for one call.
 *
 * `promptTokens` is always the **total** input the model read, whether or not the
 * provider served part of it from cache — adapters normalize the vendor-specific
 * shapes (Anthropic reports the cached part outside `input_tokens`, everyone else
 * includes it in `prompt_tokens`). `cachedPromptTokens` is a subset of it, so a
 * cache hit never inflates the token count; it only changes what it costs.
 */
export interface CallUsage {
  promptTokens: number;
  completionTokens: number;
  /** Input tokens served from a prefix cache this call. */
  cachedPromptTokens?: number;
  /** Input tokens written into an explicit cache this call (billed above 1x). */
  cacheWriteTokens?: number;
}

export interface CallResult {
  text: string;
  thinking: string;
  usage: CallUsage;
  latencyMs: number;
}

export type DeltaSink = (delta: StreamDelta) => void;

export interface ProviderAdapter {
  kind: ProviderKind;
  call(req: CallRequest, onDelta: DeltaSink): Promise<CallResult>;
}

/** Emitted for non-2xx responses so the runtime can classify (auth / rate / transient). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}
