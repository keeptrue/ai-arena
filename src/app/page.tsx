import Link from "next/link";
import { MatchLauncher } from "@/components/MatchLauncher";
import { ensureRuntime } from "@/engine/runtime";
import {
  ensureSeedData,
  listMatches,
  listModels,
  listProviders,
  listRecentLineups,
  listRulesets,
} from "@/db/repo";
import { isRubricBlueprint } from "@/engine/game";
import { syncBuiltinRulesets } from "@/lib/rulesets";
import { blueprintMeta } from "@/engine/game";
import { cacheHitPercent } from "@/lib/match-catalog";
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
      modelId: m.modelId,
      inContenderPool: m.inContenderPool,
      inJudgePool: m.inJudgePool,
      enabled: m.enabled,
    }));
  const rulesets = listRulesets()
    .filter((r) => r.enabled)
    .map((r) => {
      const bp = r.blueprint;
      const meta = blueprintMeta(bp);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        kind: meta.kind,
        rounds: meta.rounds,
        seats: meta.seats,
        tagline: bp.tagline,
        dimensions: isRubricBlueprint(bp)
          ? bp.rubric.dimensions.map((d) => ({ key: d.key, label: d.label, weight: d.weight }))
          : [],
        slots: isRubricBlueprint(bp)
          ? bp.submission.slots.map((s) => ({ key: s.key, label: s.label, reveal: s.reveal }))
          : [],
      };
    });

  const matches = listMatches(6);
  const lineups = listRecentLineups(5);

  return (
    <main className="mx-auto max-w-[1400px] px-6 pb-24">
      <section className="py-10">
        <div className="mb-6 flex items-center gap-3">
          <span className="label">规则驱动的对局 · 两种玩法</span>
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
        <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-fg-dim">
          也可以开一桌九人狼人杀：9 个模型各坐一席，身份由引擎发牌，夜间顺序行动，
          圆桌上见。胜负由状态机判定，裁判只在「法官发牌」时参与。
        </p>
      </section>

      <MatchLauncher rulesets={rulesets} models={models} lineups={lineups} />

      {matches.length > 0 && (
        <section className="mt-12 border-t border-line pt-8">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-[14px] font-medium tracking-tight">最近的战报</h2>
            <Link href="/matches" className="text-[12px] text-fg-faint transition hover:text-fg">
              所有对局 →
            </Link>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {matches.map((m) => (
              <Link
                key={m.id}
                href={`/${m.kind === "werewolf" ? "table" : m.kind === "coup" ? "coup" : "arena"}/${m.id}`}
                className="panel flex flex-col gap-2 p-3.5 transition hover:border-line-strong"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px]">{m.rulesetName}</span>
                  <span className="mono text-[10px] text-fg-faint">{m.format}</span>
                </div>
                <div className="flex items-center gap-2 text-[12px]">
                  {m.kind === "werewolf" || m.kind === "coup" ? (
                    <span className="text-fg-dim">
                      {m.kind === "coup" ? "政变" : "九人局"} · {m.winnerTeamName ? `${m.winnerTeamName}胜` : m.status === "running" ? "进行中" : m.status === "interrupted" ? (m.resumable ? "已中断 · 可续" : "已中断") : "无胜者"}
                    </span>
                  ) : (
                    m.teams.map((t) => (
                      <span key={t.id} className="flex items-center gap-1" style={{ color: t.color }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                        {t.name}
                        <span className="mono text-fg-faint">{t.total.toFixed(1)}</span>
                      </span>
                    ))
                  )}
                </div>
                <div className="mono text-[10px] text-fg-faint">
                  {m.status} · {m.rounds} {m.kind === "werewolf" ? "天" : "回合"} ·{" "}
                  {m.tokensUsed.toLocaleString()} tokens
                  {cacheHitPercent(m) !== null ? ` · ⚡${cacheHitPercent(m)}%` : ""}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
