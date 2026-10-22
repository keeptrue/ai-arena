/**
 * Turns a configured reasoning strength into the exact wire parameters each
 * provider expects. Pure functions only — adapters call these and merge the result.
 */

import { normalizeEffort } from "@/engine/reasoning";
import type { ModelSnapshot, ReasoningEffort } from "@/engine/types";

/** Anthropic refuses budgets below this, and refuses `budget_tokens >= max_tokens`. */
export const ANTHROPIC_MIN_BUDGET = 1024;

/** Effort → thinking budget for providers that take a token count. */
const ANTHROPIC_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: ANTHROPIC_MIN_BUDGET,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};

/** Gemini's documented ladder is coarser; 0 means "no thinking" where the model allows it. */
const GEMINI_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 12288,
  xhigh: 24576,
  max: 32768,
};

const GEMINI_MAX_BUDGET = 65_536;

function explicitBudget(model: ModelSnapshot): number | null {
  const raw = model.thinkingBudget;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

/**
 * Anthropic extended thinking: `budget_tokens` must sit in [1024, max_tokens), and
 * thinking is billed out of the same `max_tokens` window as the answer. Cap the
 * budget at half the window so a high setting cannot starve the visible reply.
 * Returns null when thinking is off or the window is too small to split at all.
 */
export function anthropicThinkingPlan(
  model: ModelSnapshot,
  maxTokens: number,
): { budget_tokens: number } | null {
  if (!model.supportsReasoning) return null;
  const effort = normalizeEffort(model.reasoningEffort ?? null);
  if (effort === "none") return null;

  const ceiling = Math.min(maxTokens - 1, Math.floor(maxTokens / 2));
  if (ceiling < ANTHROPIC_MIN_BUDGET) return null;

  const desired = explicitBudget(model) ?? ANTHROPIC_BUDGET[effort ?? "medium"];
  const budget = Math.max(ANTHROPIC_MIN_BUDGET, Math.min(desired, ceiling));
  return { budget_tokens: budget };
}

/**
 * Gemini `generationConfig.thinkingConfig`:
 *  - 3.x models advertise an effort ladder → `thinkingLevel`
 *  - 2.5-era models advertise a token budget → `thinkingBudget`
 *  - explicit budget always wins
 */
export function geminiThinkingConfig(model: ModelSnapshot): Record<string, unknown> | null {
  if (!model.supportsReasoning) return null;
  const effort = normalizeEffort(model.reasoningEffort ?? null);
  const budget = explicitBudget(model);

  if (budget !== null) {
    const clamped = Math.min(budget, GEMINI_MAX_BUDGET);
    return { includeThoughts: clamped > 0, thinkingBudget: clamped };
  }

  const style = model.reasoningStyle ?? "budget_tokens";
  if (style === "effort") {
    // Gemini 3.x cannot fully disable thinking; `none` just stops surfacing thoughts.
    if (!effort) return { includeThoughts: true };
    if (effort === "none") return { includeThoughts: false };
    return { includeThoughts: true, thinkingLevel: effort };
  }

  if (!effort) return { includeThoughts: true };
  const mapped = GEMINI_BUDGET[effort];
  return { includeThoughts: mapped > 0, thinkingBudget: mapped };
}

function isOpenRouter(baseUrl: string): boolean {
  return /openrouter\.ai/i.test(baseUrl);
}

/**
 * OpenAI-compatible `reasoning_effort`. OpenRouter carries the same value under
 * `reasoning.effort`, and rejects the flat field, so the URL decides the shape.
 */
export function openAiReasoningBody(model: ModelSnapshot): Record<string, unknown> {
  if (!model.supportsReasoning) return {};
  const effort = normalizeEffort(model.reasoningEffort ?? null);
  if (!effort) return {};
  return isOpenRouter(model.baseUrl) ? { reasoning: { effort } } : { reasoning_effort: effort };
}

/** Human-readable suffix for logs and the audience ("· 高思考"). */
export function shortReasoningLabel(model: ModelSnapshot): string | null {
  if (!model.supportsReasoning) return null;
  const effort = normalizeEffort(model.reasoningEffort ?? null);
  if (!effort) return "默认思考";
  const labels: Record<ReasoningEffort, string> = {
    none: "关思考",
    minimal: "极低思考",
    low: "低思考",
    medium: "中思考",
    high: "高思考",
    xhigh: "极高思考",
    max: "满思考",
  };
  return labels[effort];
}
