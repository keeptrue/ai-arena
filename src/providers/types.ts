import type { ModelSnapshot, ProviderKind } from "@/engine/types";

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface CallRequest {
  model: ModelSnapshot;
  apiKey: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Ask the provider for a JSON object when it supports a native JSON mode. */
  json?: boolean;
}

export interface StreamDelta {
  /** Reasoning / thinking channel. Forwarded to the audience live. */
  thinking?: string;
  /** Visible answer channel. */
  text?: string;
}

export interface CallResult {
  text: string;
  thinking: string;
  usage: { promptTokens: number; completionTokens: number };
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
