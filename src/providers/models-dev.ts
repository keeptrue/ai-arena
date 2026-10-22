/**
 * models.dev integration: a public, key-less catalogue of model capabilities.
 *
 * We only read what the arena actually needs: does the model reason, which knobs
 * does it expose (effort ladder / toggle / token budget), how big is its window,
 * and what does it cost. Everything is best-effort — a failed lookup must never
 * block a provider sync.
 */

import { EFFORT_ORDER, normalizeEffort } from "@/engine/reasoning";
import type { ModelCard, ProviderKind, ReasoningEffort, ReasoningOption } from "@/engine/types";

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface RawReasoningOption {
  type?: string;
  values?: string[];
  min?: number;
  max?: number;
}

interface RawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: RawReasoningOption[];
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  temperature?: boolean;
  /** The vendor's own `${provider}/${model}` id, when the catalogue knows it. */
  canonical_model_id?: string;
}

interface RawProvider {
  id?: string;
  name?: string;
  api?: string;
  models?: Record<string, RawModel>;
}

export type ModelsDevCatalog = Record<string, RawProvider>;

export interface CatalogTarget {
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
}

function catalogUrl(): string {
  return process.env.MODELS_DEV_URL?.trim() || DEFAULT_MODELS_DEV_URL;
}

/* ── provider matching ─────────────────────────────────────────────── */

/** Hosts whose models.dev provider id does not equal the host label. */
const HOST_HINTS: Array<[RegExp, string]> = [
  [/openrouter\.ai$/, "openrouter"],
  [/api\.deepseek\.com$/, "deepseek"],
  [/api\.anthropic\.com$/, "anthropic"],
  [/generativelanguage\.googleapis\.com$/, "google"],
  [/api\.openai\.com$/, "openai"],
  [/api\.moonshot\.(cn|ai)$/, "moonshotai"],
  [/api\.mistral\.ai$/, "mistral"],
  [/api\.x\.ai$/, "xai"],
  [/api\.groq\.com$/, "groq"],
  [/api\.together\.xyz$/, "togetherai"],
  [/api\.fireworks\.ai$/, "fireworks-ai"],
  [/dashscope\.aliyuncs\.com$/, "alibaba"],
  [/api\.z\.ai$/, "zai"],
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Ordered list of catalogue provider keys worth checking for this endpoint:
 * host evidence first, then the provider kind's own catalogue entry.
 */
export function candidateProviderKeys(target: Pick<CatalogTarget, "kind" | "baseUrl">, catalog: ModelsDevCatalog): string[] {
  const keys: string[] = [];
  const push = (key: string | undefined) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  if (target.kind === "anthropic") push("anthropic");
  if (target.kind === "gemini") push("google");

  const host = hostOf(target.baseUrl);
  if (host) {
    for (const [pattern, key] of HOST_HINTS) if (pattern.test(host)) push(key);
    for (const [key, provider] of Object.entries(catalog)) {
      if (provider?.api && hostOf(provider.api) === host) push(key);
    }
  }

  if (target.kind === "openai") {
    push("openai");
    push("openrouter");
  }
  return keys;
}

/* ── normalisation ─────────────────────────────────────────────────── */

function normalizeOptions(raw: RawModel): ReasoningOption[] {
  const out: ReasoningOption[] = [];
  const seen = new Set<ReasoningOption["type"]>();

  for (const option of raw.reasoning_options ?? []) {
    const type = option.type;
    if (type === "effort" && !seen.has("effort")) {
      const values = [...new Set((option.values ?? []).map(normalizeEffort).filter((v): v is ReasoningEffort => v !== null))].sort(
        (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
      );
      if (values.length === 0) continue;
      seen.add("effort");
      out.push({ type: "effort", values });
    } else if (type === "toggle" && !seen.has("toggle")) {
      seen.add("toggle");
      out.push({ type: "toggle" });
    } else if (type === "budget_tokens" && !seen.has("budget_tokens")) {
      seen.add("budget_tokens");
      const entry: Extract<ReasoningOption, { type: "budget_tokens" }> = { type: "budget_tokens" };
      if (typeof option.min === "number") entry.min = option.min;
      if (typeof option.max === "number") entry.max = option.max;
      out.push(entry);
    }
  }
  return out;
}

function toCard(providerKey: string, raw: RawModel, modelId: string): ModelCard {
  const options = normalizeOptions(raw);
  return {
    source: "models.dev",
    key: `${providerKey}/${raw.id ?? modelId}`,
    name: raw.name ?? modelId,
    contextWindow: raw.limit?.context ?? null,
    outputLimit: raw.limit?.output ?? null,
    cost:
      raw.cost && (typeof raw.cost.input === "number" || typeof raw.cost.output === "number")
        ? { input: raw.cost.input ?? null, output: raw.cost.output ?? null }
        : null,
    supportsTemperature: raw.temperature !== false,
    reasoning: !!raw.reasoning || options.length > 0,
    options,
    fetchedAt: Date.now(),
  };
}

/**
 * Gateways mirror other vendors' models, often without the vendor's knobs. Rank the
 * mirrors so the row that actually owns the model (its canonical namespace, and its
 * richest option set) wins instead of the alphabetically-first reseller.
 */
function pickBestMatch(matches: Array<{ key: string; raw: RawModel }>, modelId: string): { key: string; raw: RawModel } {
  const scored = matches.map((match, index) => {
    const canonical = match.raw.canonical_model_id ?? "";
    const options = normalizeOptions(match.raw).length;
    let score = 0;
    if (canonical === `${match.key}/${match.raw.id ?? modelId}`) score += 6;
    else if (canonical.startsWith(`${match.key}/`)) score += 4;
    if (modelId.startsWith(`${match.key}/`)) score += 3;
    score += Math.min(options, 3);
    if (match.raw.reasoning) score += 1;
    return { match, index, score };
  });
  // Stable: equal scores keep catalogue order, so lookups stay reproducible.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0].match;
}

/**
 * Finds the card for a model. Never guesses across unrelated families: an exact id
 * inside a plausible provider wins, otherwise we accept a catalogue-wide match only
 * for namespaced ids (`openai/gpt-5` on a gateway) or when the id is unique.
 */
export function lookupModelCard(catalog: ModelsDevCatalog, target: CatalogTarget): ModelCard | null {
  if (target.kind === "mock") return null;

  for (const key of candidateProviderKeys(target, catalog)) {
    const raw = catalog[key]?.models?.[target.modelId];
    if (raw) return toCard(key, raw, target.modelId);
  }

  const matches: Array<{ key: string; raw: RawModel }> = [];
  for (const [key, provider] of Object.entries(catalog)) {
    const raw = provider?.models?.[target.modelId];
    if (raw) matches.push({ key, raw });
  }
  if (matches.length === 0) return null;

  const chosen = pickBestMatch(matches, target.modelId);
  return toCard(chosen.key, chosen.raw, target.modelId);
}

/* ── network + cache ───────────────────────────────────────────────── */

const G = globalThis as unknown as { __modelsDevCatalog?: { at: number; data: ModelsDevCatalog } };

export function invalidateCatalogCache(): void {
  G.__modelsDevCatalog = undefined;
}

export async function loadCatalog(): Promise<ModelsDevCatalog> {
  const cached = G.__modelsDevCatalog;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const res = await fetch(catalogUrl(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`models.dev 返回 HTTP ${res.status}`);
  const data = (await res.json()) as ModelsDevCatalog;
  if (!data || typeof data !== "object") throw new Error("models.dev 返回的不是对象");

  G.__modelsDevCatalog = { at: Date.now(), data };
  return data;
}

/** Fetch (cached) and look up in one shot. Throws only when the catalogue itself is unreachable. */
export async function fetchModelCard(target: CatalogTarget): Promise<ModelCard | null> {
  if (target.kind === "mock") return null;
  const catalog = await loadCatalog();
  return lookupModelCard(catalog, target);
}
