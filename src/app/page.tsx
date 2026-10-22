import Link from "next/link";
import { MatchLauncher } from "@/components/MatchLauncher";
import { ensureRuntime } from "@/engine/runtime";
import { ensureSeedData, listMatches, listModels, listProviders, listRulesets } from "@/db/repo";
import { syncBuiltinRulesets } from "@/lib/rulesets";
import { maskedSecrets } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  ensureRuntime();
  ensureSeedData();
  await syncBuiltinRulesets();

  const secrets = maskedSecrets();
  const providers = listProviders();
  const keyed = new Set(
    providers.filter((p) => p.kind === "mock" || !!secrets[p.id]).map((p) => p.id),
  );
  const models = listModels()
    .filter((m) => m.enabled && keyed.has(m.providerId))
    .map((m) => ({
      id: m.id,
      display: m.display,
      providerId: m.providerId,
      providerName: m.providerName,
      inContenderPool: m.inContenderPool,
      inJudgePool: m.inJudgePool,
      enabled: m.enabled,
    }));
  const rulesets = listRulesets()
    .filter((r) => r.enabled)
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      rounds: r.blueprint.rounds,
      tagline: r.blueprint.tagline,
      dimensions: r.blueprint.rubric.dimensions.map((d) => ({ key: d.key, label: d.label, weight: d.weight })),
      slots: r.blueprint.submission.slots.map((s) => ({ key: s.key, label: s.label, reveal: s.reveal })),
    }));

  const matches = listMatches(6);

  return (
    <main className="mx-auto max-w-[1400px] px-6 pb-24">
      <section className="py-10">
        <div className="mb-6 flex items-center gap-3">
          <span className="label">规则驱动的对局</span>
          <span className="h-px w-10 bg-line-strong" />
          <span className="label mono">{rulesets.length} 套规则 · {models.length} 个模型</span>
        </div>
        <h1 className="text-balance text-[40px] leading-[1.1] font-semibold tracking-[-0.03em]">
          全员同时出招，
          <br />
          <span className="text-jade">裁判统一裁决。</span>
        </h1>
        <p className="mt-4 max-w-[62ch] text-[14px] leading-relaxed text-fg-dim">
          每一轮，所有模型并行思考、并行提交，谁先交不构成优劣；全员到齐才交给裁判裁决。
          思考只给观众看，对手看不到，裁判也看不到——他读的只有你交上去的那份东西。
        </p>
      </section>

      <MatchLauncher rulesets={rulesets} models={models} />

      {matches.length > 0 && (
        <section className="mt-12 border-t border-line pt-8">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-[14px] font-medium tracking-tight">最近的战报</h2>
            <Link href="/matches" className="text-[12px] text-fg-faint transition hover:text-fg">
              全部 →
            </Link>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {matches.map((m) => (
              <Link
                key={m.id}
                href={`/arena/${m.id}`}
                className="panel flex flex-col gap-2 p-3.5 transition hover:border-line-strong"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px]">{m.rulesetName}</span>
                  <span className="mono text-[10px] text-fg-faint">{m.format}</span>
                </div>
                <div className="flex items-center gap-2 text-[12px]">
                  {m.teams.map((t) => (
                    <span key={t.id} className="flex items-center gap-1" style={{ color: t.color }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                      {t.name}
                      <span className="mono text-fg-faint">{t.total.toFixed(1)}</span>
                    </span>
                  ))}
                </div>
                <div className="mono text-[10px] text-fg-faint">
                  {m.status} · {m.rounds} 轮 · {m.tokensUsed.toLocaleString()} tokens
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
