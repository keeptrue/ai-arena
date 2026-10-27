/**
 * Compiles a natural-language rule set into a Blueprint.
 *
 * The engine never reads the prose — it only obeys the compiled slots, rounds and
 * rubric. So this step is the one place where the rules become machine-shaped.
 */

import { BlueprintError, MAX_DIMENSIONS, MAX_ROUNDS, MAX_SLOTS, parseBlueprint } from "@/engine/blueprint";
import { getPromptOverride, listModels, listProviders, snapshotModel } from "@/db/repo";
import { renderPromptTemplate, resolvePromptBody } from "@/engine/prompt-templates";
import { getSecret } from "@/lib/secrets";
import { callWithRetry } from "@/providers";
import { repairJson } from "@/engine/parse";
import type { Blueprint, ModelSnapshot } from "@/engine/types";

export interface CompileResult {
  blueprint: Blueprint;
  compiler: string;
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number };
  warnings: string[];
}

function compilerModel(): ModelSnapshot | null {
  const keyed = new Set(
    listProviders()
      .filter((p) => p.kind === "mock" || !!getSecret(p.id))
      .map((p) => p.id),
  );
  const pool = listModels().filter((m) => m.enabled && keyed.has(m.providerId));
  const preferred = pool.filter((m) => m.inJudgePool);
  const chosen = (preferred.length ? preferred : pool)[0];
  return chosen ? snapshotModel(chosen.id) : null;
}

/** Built-in wording lives in engine/prompt-templates.ts; this only fills the limits. */
function compileSystem(): string {
  const body = resolvePromptBody("compile.system", getPromptOverride("compile.system"));
  return renderPromptTemplate(body, {
    maxRounds: String(MAX_ROUNDS),
    maxSlots: String(MAX_SLOTS),
    maxDimensions: String(MAX_DIMENSIONS),
  });
}

export async function compileRuleset(input: {
  sourceMd: string;
  name?: string;
}): Promise<CompileResult> {
  const model = compilerModel();
  if (!model) throw new Error("没有可用于编译的模型：先去 /setups 填一个 Key 或启用本地演练体");
  const apiKey = getSecret(model.providerId);

  const messages = [{ role: "user" as const, content: input.sourceMd.slice(0, 12000) }];
  const warnings: string[] = [];
  const system = compileSystem();

  const first = await callWithRetry(
    { model, apiKey, system, messages },
    () => {},
  );

  const tryParse = (text: string): Blueprint => {
    const json = JSON.parse(repairJson(text)) as unknown;
    return parseBlueprint(json);
  };

  try {
    const blueprint = tryParse(first.text);
    return { blueprint, compiler: model.display, usage: first.usage, warnings };
  } catch (err) {
    const issues =
      err instanceof BlueprintError
        ? err.issues
        : [err instanceof Error ? err.message : String(err)];
    warnings.push(`首次编译未通过：${issues.join("；")}`);

    // One repair pass with the validator's complaints in hand.
    const repaired = await callWithRetry(
      {
        model: { ...model, temperature: 0 },
        apiKey,
        system,
        messages: [
          ...messages,
          { role: "assistant" as const, content: first.text },
          { role: "user" as const, content: `上一版不合法：\n${issues.join("\n")}\n只输出修正后的 JSON。` },
        ],
      },
      () => {},
    );

    const blueprint = tryParse(repaired.text);
    warnings.push("已通过一次修复重试");
    return {
      blueprint,
      compiler: model.display,
      usage: {
        promptTokens: first.usage.promptTokens + repaired.usage.promptTokens,
        completionTokens: first.usage.completionTokens + repaired.usage.completionTokens,
        cachedPromptTokens: (first.usage.cachedPromptTokens ?? 0) + (repaired.usage.cachedPromptTokens ?? 0),
      },
      warnings,
    };
  }
}
