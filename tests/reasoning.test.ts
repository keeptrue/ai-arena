import { describe, expect, test } from "bun:test";
import {
  EFFORT_ORDER,
  effortsFromCard,
  normalizeEffort,
  reconcileEffort,
  reasoningStyleFor,
  suggestedEffort,
} from "../src/engine/reasoning";
import { anthropicThinkingPlan, geminiThinkingConfig, openAiReasoningBody } from "../src/providers/reasoning";
import { lookupModelCard, type ModelsDevCatalog } from "../src/providers/models-dev";
import type { ModelCard, ModelSnapshot } from "../src/engine/types";

function snapshot(patch: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return {
    providerId: "p",
    providerName: "供应商",
    kind: "openai",
    baseUrl: "https://api.example.com/v1",
    modelId: "m",
    display: "模型",
    temperature: 0.9,
    supportsReasoning: true,
    ...patch,
  };
}

/* ── fixture catalogue: mirrors models.dev's real shape ───────────── */

const CATALOG: ModelsDevCatalog = {
  openrouter: {
    id: "openrouter",
    api: "https://openrouter.ai/api/v1",
    models: {
      "openai/gpt-5": {
        id: "openai/gpt-5",
        name: "GPT-5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["high", "low", "medium"] }],
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 1.25, output: 10 },
      },
      "deepseek/deepseek-chat": { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", reasoning: false },
      "acme/rigid": { id: "acme/rigid", name: "Rigid", reasoning: true, temperature: false },
    },
  },
  anthropic: {
    models: {
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
    },
  },
  google: {
    models: {
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 128, max: 32768 }],
        limit: { context: 1_048_576, output: 65_536 },
      },
      "gemini-3.1-flash": {
        id: "gemini-3.1-flash",
        name: "Gemini 3.1 Flash",
        reasoning: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["minimal", "low", "medium", "high"] },
        ],
      },
    },
  },
  deepseek: {
    api: "https://api.deepseek.com",
    models: {
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      },
    },
  },
};

/* ── effort vocabulary ────────────────────────────────────────────── */

describe("reasoning effort vocabulary", () => {
  test("normalises case and rejects unknown rungs", () => {
    expect(normalizeEffort(" HIGH ")).toBe("high");
    expect(normalizeEffort("turbo")).toBeNull();
    expect(normalizeEffort(undefined)).toBeNull();
    expect(normalizeEffort(3)).toBeNull();
  });

  test("sorts card effort values weakest-first regardless of source order", () => {
    const card = lookupModelCard(CATALOG, {
      kind: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "openai/gpt-5",
    })!;
    expect(effortsFromCard(card)).toEqual(["low", "medium", "high"]);
  });

  test("suggests the middle rung and drops stale choices", () => {
    const card = lookupModelCard(CATALOG, { kind: "gemini", baseUrl: "", modelId: "gemini-3.1-flash" })!;
    expect(suggestedEffort(card)).toBe("medium");
    expect(reconcileEffort("xhigh", card)).toBeNull();
    expect(reconcileEffort("low", card)).toBe("low");
    expect(reconcileEffort(null, card)).toBeNull();
  });

  test("picks the protocol knob per provider generation", () => {
    const gemini25 = lookupModelCard(CATALOG, { kind: "gemini", baseUrl: "", modelId: "gemini-2.5-pro" })!;
    const gemini3 = lookupModelCard(CATALOG, { kind: "gemini", baseUrl: "", modelId: "gemini-3.1-flash" })!;
    expect(reasoningStyleFor({ kind: "gemini", card: gemini25 })).toBe("budget_tokens");
    expect(reasoningStyleFor({ kind: "gemini", card: gemini3 })).toBe("effort");
    expect(reasoningStyleFor({ kind: "anthropic", card: null })).toBe("budget_tokens");
    expect(reasoningStyleFor({ kind: "openai", card: null })).toBe("effort");
    expect(reasoningStyleFor({ kind: "mock", card: null })).toBeNull();
  });
});

/* ── catalogue matching ───────────────────────────────────────────── */

describe("models.dev lookup", () => {
  test("matches by provider host", () => {
    const card = lookupModelCard(CATALOG, {
      kind: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-v4-pro",
    })!;
    expect(card.key).toBe("deepseek/deepseek-v4-pro");
    expect(card.reasoning).toBe(true);
    expect(card.options.map((o) => o.type)).toEqual(["toggle", "effort"]);
  });

  test("falls back to the provider kind when the catalogue has no api url", () => {
    const anthropicCard = lookupModelCard(CATALOG, {
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-5",
    })!;
    expect(anthropicCard.key).toBe("anthropic/claude-sonnet-4-5");
    expect(anthropicCard.options[0]).toEqual({ type: "budget_tokens", min: 1024 });

    const geminiCard = lookupModelCard(CATALOG, {
      kind: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      modelId: "gemini-2.5-pro",
    })!;
    expect(geminiCard.key).toBe("google/gemini-2.5-pro");
    expect(geminiCard.outputLimit).toBe(65_536);
  });

  test("accepts namespaced ids hosted by a custom gateway", () => {
    const card = lookupModelCard(CATALOG, {
      kind: "openai",
      baseUrl: "https://my-proxy.example.com/v1",
      modelId: "openai/gpt-5",
    })!;
    expect(card.key).toBe("openrouter/openai/gpt-5");
    expect(card.contextWindow).toBe(400_000);
    expect(card.cost).toEqual({ input: 1.25, output: 10 });
  });

  test("returns null for unknown models and for the mock provider", () => {
    expect(lookupModelCard(CATALOG, { kind: "openai", baseUrl: "", modelId: "nope" })).toBeNull();
    expect(lookupModelCard(CATALOG, { kind: "mock", baseUrl: "local://mock", modelId: "openai/gpt-5" })).toBeNull();
  });

  test("prefers the vendor that canonically owns a mirrored model id", () => {
    const catalog: ModelsDevCatalog = {
      aaa: { models: { "shared-model": { id: "shared-model", name: "镜像", reasoning: true } } },
      zhipuai: {
        models: {
          "shared-model": {
            id: "shared-model",
            name: "正主",
            reasoning: true,
            canonical_model_id: "zhipuai/shared-model",
          },
        },
      },
    };
    const card = lookupModelCard(catalog, { kind: "openai", baseUrl: "http://127.0.0.1:3066/v1", modelId: "shared-model" })!;
    expect(card.key).toBe("zhipuai/shared-model");
    expect(card.name).toBe("正主");
  });

  test("captures whether the model tolerates a temperature", () => {
    const rigid = lookupModelCard(CATALOG, {
      kind: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "acme/rigid",
    })!;
    expect(rigid.supportsTemperature).toBe(false);
    const flexible = lookupModelCard(CATALOG, { kind: "gemini", baseUrl: "", modelId: "gemini-2.5-pro" })!;
    expect(flexible.supportsTemperature).toBe(true);
  });

  test("prefers the owning vendor over a mirror whose ids point at a dated alias", () => {
    const catalog: ModelsDevCatalog = {
      azure: {
        models: {
          "deepseek-v4-pro": {
            id: "deepseek-v4-pro",
            name: "镜像",
            reasoning: true,
            canonical_model_id: "deepseek/deepseek-v4-pro",
          },
        },
      },
      deepseek: {
        models: {
          "deepseek-v4-pro": {
            id: "deepseek-v4-pro",
            name: "正主",
            reasoning: true,
            canonical_model_id: "deepseek/deepseek-v4-pro-0813",
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["high", "low", "max"] },
            ],
          },
        },
      },
    };
    const card = lookupModelCard(catalog, {
      kind: "openai",
      baseUrl: "http://127.0.0.1:8788/v1",
      modelId: "deepseek-v4-pro",
    })!;
    expect(card.key).toBe("deepseek/deepseek-v4-pro");
    expect(card.name).toBe("正主");
    expect(effortsFromCard(card)).toEqual(["low", "high", "max"]);
  });

  test("treats reasoning options as capability evidence even without the flag", () => {
    const catalog: ModelsDevCatalog = {
      x: { models: { m: { id: "m", reasoning_options: [{ type: "effort", values: ["low", "max"] }] } } },
    };
    const card = lookupModelCard(catalog, { kind: "openai", baseUrl: "", modelId: "m" })!;
    expect(card.reasoning).toBe(true);
  });
});

/* ── wire parameters ──────────────────────────────────────────────── */

describe("anthropic thinking plan", () => {
  test("maps effort to a budget", () => {
    expect(anthropicThinkingPlan(snapshot({ kind: "anthropic", reasoningEffort: "high" }), 200_000)).toEqual({
      budget_tokens: 8192,
    });
    expect(anthropicThinkingPlan(snapshot({ kind: "anthropic", reasoningEffort: "low" }), 200_000)).toEqual({
      budget_tokens: 2048,
    });
  });

  test("clamps into [1024, maxTokens/2] and disables when the window cannot split", () => {
    // 4000 tokens → at most 2000 for thinking, so the answer still has room.
    expect(anthropicThinkingPlan(snapshot({ reasoningEffort: "max" }), 4000)).toEqual({ budget_tokens: 2000 });
    expect(anthropicThinkingPlan(snapshot({ reasoningEffort: "low" }), 1025)).toBeNull();
    expect(anthropicThinkingPlan(snapshot({ reasoningEffort: "high" }), 2000)).toBeNull();
    expect(anthropicThinkingPlan(snapshot({ reasoningEffort: "high" }), 4096)).toEqual({ budget_tokens: 2048 });
  });

  test("honours explicit budgets, 'none', and the reasoning toggle", () => {
    expect(
      anthropicThinkingPlan(snapshot({ reasoningEffort: "low", thinkingBudget: 5000 }), 200_000),
    ).toEqual({ budget_tokens: 5000 });
    expect(anthropicThinkingPlan(snapshot({ reasoningEffort: "low", thinkingBudget: 10 }), 200_000)).toEqual({
      budget_tokens: 1024,
    });
    expect(anthropicThinkingPlan(snapshot({ reasoningEffort: "none" }), 200_000)).toBeNull();
    expect(anthropicThinkingPlan(snapshot({ supportsReasoning: false, reasoningEffort: "high" }), 200_000)).toBeNull();
  });
});

describe("gemini thinking config", () => {
  test("uses thinkingLevel for effort-style models", () => {
    expect(geminiThinkingConfig(snapshot({ kind: "gemini", reasoningStyle: "effort", reasoningEffort: "high" }))).toEqual({
      includeThoughts: true,
      thinkingLevel: "high",
    });
    expect(
      geminiThinkingConfig(snapshot({ kind: "gemini", reasoningStyle: "effort", reasoningEffort: "none" })),
    ).toEqual({ includeThoughts: false });
  });

  test("uses thinkingBudget for budget-style models", () => {
    expect(
      geminiThinkingConfig(snapshot({ kind: "gemini", reasoningStyle: "budget_tokens", reasoningEffort: "high" })),
    ).toEqual({ includeThoughts: true, thinkingBudget: 12288 });
    expect(
      geminiThinkingConfig(snapshot({ kind: "gemini", reasoningStyle: "budget_tokens", reasoningEffort: "none" })),
    ).toEqual({ includeThoughts: false, thinkingBudget: 0 });
    expect(geminiThinkingConfig(snapshot({ kind: "gemini", reasoningStyle: "budget_tokens" }))).toEqual({
      includeThoughts: true,
    });
  });

  test("explicit budget wins and is capped", () => {
    expect(
      geminiThinkingConfig(snapshot({ kind: "gemini", thinkingBudget: 3000, reasoningEffort: "low" })),
    ).toEqual({ includeThoughts: true, thinkingBudget: 3000 });
    expect(geminiThinkingConfig(snapshot({ kind: "gemini", thinkingBudget: 999_999 }))).toEqual({
      includeThoughts: true,
      thinkingBudget: 65_536,
    });
  });

  test("stays silent when the model has no reasoning channel", () => {
    expect(geminiThinkingConfig(snapshot({ kind: "gemini", supportsReasoning: false, reasoningEffort: "high" }))).toBeNull();
  });
});

describe("openai reasoning body", () => {
  test("flat field for OpenAI-compatible endpoints", () => {
    expect(openAiReasoningBody(snapshot({ reasoningEffort: "high" }))).toEqual({ reasoning_effort: "high" });
  });

  test("nested field for OpenRouter", () => {
    expect(
      openAiReasoningBody(snapshot({ baseUrl: "https://openrouter.ai/api/v1", reasoningEffort: "medium" })),
    ).toEqual({ reasoning: { effort: "medium" } });
  });

  test("omits the knob entirely when unset or unsupported", () => {
    expect(openAiReasoningBody(snapshot({ reasoningEffort: null }))).toEqual({});
    expect(openAiReasoningBody(snapshot({ supportsReasoning: false, reasoningEffort: "high" }))).toEqual({});
  });

  test("every effort rung is expressible", () => {
    for (const effort of EFFORT_ORDER) {
      expect(openAiReasoningBody(snapshot({ reasoningEffort: effort }))).toEqual({
        reasoning_effort: effort,
      });
    }
  });
});

/* ── card shape sanity ────────────────────────────────────────────── */

test("a card without reasoning carries no knobs", () => {
  const card: ModelCard = {
    source: "models.dev",
    key: "openrouter/deepseek/deepseek-chat",
    name: "DeepSeek Chat",
    contextWindow: null,
    outputLimit: null,
    cost: null,
    reasoning: false,
    options: [],
    fetchedAt: 0,
  };
  expect(effortsFromCard(card)).toEqual([]);
  expect(suggestedEffort(card)).toBeNull();
});
