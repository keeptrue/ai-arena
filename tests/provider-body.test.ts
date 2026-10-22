import { afterEach, describe, expect, test } from "bun:test";
import { anthropic } from "../src/providers/anthropic";
import { gemini } from "../src/providers/gemini";
import { openaiCompat } from "../src/providers/openai-compat";
import type { ModelSnapshot } from "../src/engine/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Intercepts the outgoing request and records its JSON body. */
function captureFetch(reply: () => Response): { body: () => Record<string, unknown> } {
  let seen: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return reply();
  }) as typeof fetch;
  return { body: () => seen };
}

function snapshot(patch: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return {
    providerId: "p",
    providerName: "供应商",
    kind: "openai",
    baseUrl: "https://api.example.com/v1",
    modelId: "m",
    display: "模型",
    temperature: 0.7,
    supportsReasoning: true,
    ...patch,
  };
}

const OPENAI_STREAM =
  'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
  "data: [DONE]\n\n";

const ANTHROPIC_STREAM =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想一想"}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n';

const GEMINI_STREAM =
  'data: {"candidates":[{"content":{"parts":[{"text":"想一想","thought":true},{"text":"好"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}\n\n';

const REQ = {
  apiKey: "sk-test",
  system: "系统",
  messages: [{ role: "user" as const, content: "问题" }],
};

describe("reasoning parameters reach the wire", () => {
  test("openai-compat sends reasoning_effort and keeps temperature when allowed", async () => {
    const spy = captureFetch(() => sse(OPENAI_STREAM));
    await openaiCompat.call({ ...REQ, model: snapshot({ reasoningEffort: "high" }) }, () => {});
    expect(spy.body()).toMatchObject({ reasoning_effort: "high", temperature: 0.7, stream: true });
  });

  test("openai-compat routes effort into reasoning.effort on OpenRouter", async () => {
    const spy = captureFetch(() => sse(OPENAI_STREAM));
    await openaiCompat.call(
      { ...REQ, model: snapshot({ baseUrl: "https://openrouter.ai/api/v1", reasoningEffort: "medium" }) },
      () => {},
    );
    expect(spy.body().reasoning).toEqual({ effort: "medium" });
    expect(spy.body()).not.toHaveProperty("reasoning_effort");
  });

  test("openai-compat drops temperature for models that reject it", async () => {
    const spy = captureFetch(() => sse(OPENAI_STREAM));
    await openaiCompat.call({ ...REQ, model: snapshot({ supportsTemperature: false, reasoningEffort: "high" }) }, () => {});
    expect(spy.body()).not.toHaveProperty("temperature");
    expect(spy.body()).toMatchObject({ reasoning_effort: "high" });
  });

  test("anthropic sends thinking.budget_tokens and omits temperature", async () => {
    const spy = captureFetch(() => sse(ANTHROPIC_STREAM));
    await anthropic.call(
      { ...REQ, model: snapshot({ kind: "anthropic", reasoningEffort: "high" }) },
      () => {},
    );
    expect(spy.body()).toMatchObject({ thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(spy.body()).not.toHaveProperty("temperature");
  });

  test("anthropic honours an explicit budget", async () => {
    const spy = captureFetch(() => sse(ANTHROPIC_STREAM));
    await anthropic.call(
      {
        ...REQ,
        model: snapshot({ kind: "anthropic", reasoningEffort: "low", thinkingBudget: 3000 }),
      },
      () => {},
    );
    expect(spy.body()).toMatchObject({ thinking: { type: "enabled", budget_tokens: 3000 } });
  });

  test("gemini uses thinkingLevel for effort-style models", async () => {
    const spy = captureFetch(() => sse(GEMINI_STREAM));
    await gemini.call(
      { ...REQ, model: snapshot({ kind: "gemini", reasoningStyle: "effort", reasoningEffort: "high" }) },
      () => {},
    );
    const config = (spy.body().generationConfig ?? {}) as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" });
    expect(config.temperature).toBe(0.7);
  });

  test("gemini uses thinkingBudget and skips temperature when unsupported", async () => {
    const spy = captureFetch(() => sse(GEMINI_STREAM));
    await gemini.call(
      {
        ...REQ,
        model: snapshot({
          kind: "gemini",
          reasoningStyle: "budget_tokens",
          reasoningEffort: "high",
          supportsTemperature: false,
        }),
      },
      () => {},
    );
    const config = (spy.body().generationConfig ?? {}) as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 12288 });
    expect(config).not.toHaveProperty("temperature");
  });

  test("no reasoning config means no reasoning field at all", async () => {
    const spy = captureFetch(() => sse(OPENAI_STREAM));
    await openaiCompat.call({ ...REQ, model: snapshot({ supportsReasoning: false }) }, () => {});
    expect(spy.body()).not.toHaveProperty("reasoning_effort");
    expect(spy.body()).not.toHaveProperty("reasoning");
  });
});

describe("output ceiling", () => {
  test("openai-compat sends no max_tokens at all", async () => {
    const spy = captureFetch(() => sse(OPENAI_STREAM));
    await openaiCompat.call({ ...REQ, model: snapshot() }, () => {});
    expect(spy.body()).not.toHaveProperty("max_tokens");
  });

  test("an explicit caller ceiling still reaches the wire", async () => {
    const spy = captureFetch(() => sse(OPENAI_STREAM));
    await openaiCompat.call({ ...REQ, model: snapshot(), maxTokens: 4096 }, () => {});
    expect(spy.body().max_tokens).toBe(4096);
  });

  test("gemini sends no maxOutputTokens at all", async () => {
    const spy = captureFetch(() => sse(GEMINI_STREAM));
    await gemini.call({ ...REQ, model: snapshot({ kind: "gemini" }) }, () => {});
    const config = (spy.body().generationConfig ?? {}) as Record<string, unknown>;
    expect(config).not.toHaveProperty("maxOutputTokens");
  });

  test("anthropic sends the unlimited ceiling and falls back when the model rejects it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "max_tokens: 64000 > 8192" } }), {
          status: 400,
        });
      }
      return sse(ANTHROPIC_STREAM);
    }) as typeof fetch;

    await anthropic.call(
      { ...REQ, model: snapshot({ kind: "anthropic", reasoningEffort: "high" }) },
      () => {},
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0].max_tokens).toBe(64_000);
    expect(bodies[1].max_tokens).toBe(8_192);
  });
});
