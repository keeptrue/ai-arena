/**
 * Reasoning-strength vocabulary shared by the DB, the UI and the providers.
 *
 * models.dev describes three shapes of knob: an effort ladder (`reasoning_effort`),
 * a token budget (`thinking.budget_tokens` / `thinkingBudget`), or a plain toggle.
 * Everything here is pure; protocol shaping lives in `src/providers/reasoning.ts`.
 */

import type { ModelCard, ReasoningEffort, ReasoningOption, ReasoningStyle } from "./types";

/** Weakest → strongest. Used for sorting and for picking a sensible default. */
export const EFFORT_ORDER: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Offered when a card says "reasoning" but not which rungs it accepts. */
export const DEFAULT_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

const EFFORT_SET = new Set<string>(EFFORT_ORDER);

export function normalizeEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return EFFORT_SET.has(v) ? (v as ReasoningEffort) : null;
}

/** Card → the effort rungs the UI may offer, weakest first. */
export function effortsFromCard(card: ModelCard | null | undefined): ReasoningEffort[] {
  const option = card?.options.find((o): o is Extract<ReasoningOption, { type: "effort" }> => o.type === "effort");
  if (!option?.values.length) return [];
  const sorted = [...new Set(option.values)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return sorted;
}

/** Levels to render in a picker: card truth first, generic ladder as a fallback. */
export function effortLevelsFor(card: ModelCard | null | undefined, supportsReasoning: boolean): ReasoningEffort[] {
  const fromCard = effortsFromCard(card);
  if (fromCard.length > 0) return fromCard;
  return supportsReasoning || card?.reasoning ? DEFAULT_EFFORTS : [];
}

/**
 * Which protocol knob a model speaks. Anthropic always takes a budget; OpenAI-compatible
 * endpoints take `reasoning_effort`; Gemini differs per generation (3.x = thinkingLevel).
 */
export function reasoningStyleFor(input: {
  kind: "openai" | "anthropic" | "gemini" | "mock";
  card?: ModelCard | null;
}): ReasoningStyle | null {
  const options = input.card?.options ?? [];
  const has = (type: ReasoningOption["type"]) => options.some((o) => o.type === type);

  if (input.kind === "anthropic") return "budget_tokens";
  if (input.kind === "gemini") {
    if (has("budget_tokens")) return "budget_tokens";
    if (has("effort")) return "effort";
    if (has("toggle")) return "toggle";
    return "budget_tokens";
  }
  if (input.kind === "openai") {
    if (has("effort")) return "effort";
    if (has("toggle")) return "toggle";
    return "effort";
  }
  return null;
}

/** Default rung for a freshly calibrated model: the middle of what it actually supports. */
export function suggestedEffort(card: ModelCard | null | undefined): ReasoningEffort | null {
  if (!card?.reasoning) return null;
  const levels = effortsFromCard(card);
  if (levels.includes("medium")) return "medium";
  return levels.find((e) => e !== "none") ?? null;
}

/** Drops a stored effort that the card no longer allows, so stale config cannot leak through. */
export function reconcileEffort(
  stored: ReasoningEffort | null | undefined,
  card: ModelCard | null | undefined,
): ReasoningEffort | null {
  const value = normalizeEffort(stored);
  if (!value) return null;
  const levels = effortsFromCard(card);
  if (levels.length > 0 && !levels.includes(value)) return null;
  return value;
}
