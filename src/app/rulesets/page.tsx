import { RulesetEditor } from "@/components/RulesetEditor";
import { ensureRuntime } from "@/engine/runtime";
import { ensureSeedData, listRulesets } from "@/db/repo";
import { syncBuiltinRulesets } from "@/lib/rulesets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function RulesetsPage() {
  ensureRuntime();
  ensureSeedData();
  await syncBuiltinRulesets();

  const rulesets = listRulesets().map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    sourceMd: r.sourceMd,
    blueprint: r.blueprint,
  }));

  return (
    <main className="mx-auto max-w-[1500px] px-6 pb-24">
      <header className="py-8">
        <h1 className="text-[22px] font-semibold tracking-tight">规则</h1>
        <p className="mt-1.5 max-w-[68ch] text-[13px] leading-relaxed text-fg-dim">
          左边写自然语言规则，点「编译」让模型把它变成结构化蓝图；确认无误后保存，就能拿去开局。
          评分局里引擎不理解规则语义——它只按蓝图里的回合数、提交项和评分维度调度。
          九人局是结构化对局类型：直接编辑 JSON 的 `roles / rules`，不走评分编译器。
        </p>
      </header>
      <RulesetEditor initial={rulesets} />
    </main>
  );
}
