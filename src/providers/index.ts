import type { ProviderKind } from "@/engine/types";
import { anthropic } from "./anthropic";
import { gemini } from "./gemini";
import { openaiCompat } from "./openai-compat";
import { mock } from "./mock";
import { ProviderError, type CallRequest, type CallResult, type DeltaSink, type ProviderAdapter } from "./types";

const registry: Record<ProviderKind, ProviderAdapter> = {
  openai: openaiCompat,
  anthropic,
  gemini,
  mock,
};

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  return registry[kind];
}

const BACKOFF_MS = [250, 1000, 3000];

/** Retries transient failures (429 / 5xx / network) with backoff. Auth errors fail fast. */
export async function callWithRetry(
  req: CallRequest,
  onDelta: DeltaSink,
  onRetry?: (attempt: number, error: Error) => void,
): Promise<CallResult> {
  const adapter = adapterFor(req.model.kind);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await adapter.call(req, onDelta);
    } catch (err) {
      const error = err as Error;
      lastError = error;
      const retryable =
        error instanceof ProviderError ? error.retryable : !/aborted|abort/i.test(error.message);
      if (!retryable || attempt === BACKOFF_MS.length) break;
      onRetry?.(attempt + 1, error);
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }
  throw lastError ?? new Error("provider call failed");
}

export { ProviderError };
export type { CallRequest, CallResult, DeltaSink, ProviderAdapter };
