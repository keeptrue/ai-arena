"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

export interface RuleSummary {
  id: string;
  slug: string;
  name: string;
  rounds: number;
  tagline: string;
  dimensions: Array<{ key: string; label: string; weight: number }>;
  slots: Array<{ key: string; label: string; reveal: string }>;
}

export interface PoolModel {
  id: string;
  display: string;
  providerId: string;
  providerName: string;
  inContenderPool: boolean;
  inJudgePool: boolean;
  enabled: boolean;
}

interface TeamDraft {
  name: string;
  modelIds: string[];
}

const PRESETS: Array<{ label: string; sizes: number[] }> = [
  { label: "1v1", sizes: [1, 1] },
  { label: "1v2", sizes: [1, 2] },
  { label: "2v2", sizes: [2, 2] },
  { label: "1v1v1", sizes: [1, 1, 1] },
  { label: "2v1v1", sizes: [2, 1, 1] },
];

/** Last explicit judge, remembered per browser so a repeated setup is two clicks. */
const JUDGE_KEY = "arena.judgeModelId";

export function MatchLauncher({
  rulesets,
  models,
}: {
  rulesets: RuleSummary[];
  models: PoolModel[];
}) {
  const router = useRouter();
  const [pendingNav, startTransition] = useTransition();
  const [rulesetId, setRulesetId] = useState(rulesets[0]?.id ?? "");
  const [preset, setPreset] = useState(0);
  const [mode, setMode] = useState<"random" | "manual">("random");
  const [manual, setManual] = useState<TeamDraft[]>([
    { name: "", modelIds: [] },
    { name: "", modelIds: [] },
  ]);
  const [judgeModelId, setJudgeModelId] = useState("auto");
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pool = useMemo(
    () => models.filter((m) => m.enabled && m.inContenderPool),
    [models],
  );
  const judgePool = useMemo(
    () => models.filter((m) => m.enabled && m.inJudgePool),
    [models],
  );
  const judgeGroups = useMemo(() => {
    const groups = new Map<string, { providerName: string; models: PoolModel[] }>();
    for (const m of judgePool) {
      const group = groups.get(m.providerId) ?? { providerName: m.providerName, models: [] };
      group.models.push(m);
      groups.set(m.providerId, group);
    }
    return [...groups.entries()];
  }, [judgePool]);

  // Restore only if the saved model still sits in the judge pool; otherwise stay auto.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(JUDGE_KEY);
      if (saved && judgePool.some((m) => m.id === saved)) setJudgeModelId(saved);
    } catch {
      /* storage can be unavailable (private mode) — auto is a fine fallback */
    }
  }, [judgePool]);

  function pickJudge(id: string) {
    setJudgeModelId(id);
    try {
      if (id === "auto") window.localStorage.removeItem(JUDGE_KEY);
      else window.localStorage.setItem(JUDGE_KEY, id);
    } catch {
      /* persistence is best-effort */
    }
  }

  const selected = rulesets.find((r) => r.id === rulesetId) ?? rulesets[0];
  const sizes = PRESETS[preset].sizes;
  const seatCount = mode === "random" ? sizes.reduce((a, b) => a + b, 0) : manual.reduce((a, t) => a + t.modelIds.length, 0);

  const canStart =
    !!selected &&
    pool.length >= 2 &&
    (mode === "random"
      ? pool.length >= seatCount
      : manual.length >= 2 && manual.every((t) => t.modelIds.length >= 1));

  const chosenJudge = judgePool.find((m) => m.id === judgeModelId) ?? null;
  // Only a manual roster is known before the draw, so only then can we name the clash.
  const clashSeats =
    mode === "manual" && chosenJudge
      ? manual.reduce(
          (n, team) =>
            n +
            team.modelIds.filter(
              (id) => pool.find((m) => m.id === id)?.providerId === chosenJudge.providerId,
            ).length,
          0,
        )
      : 0;

  function addToTeam(teamIdx: number, modelId: string) {
    setManual((prev) =>
      prev.map((t, i) =>
        i === teamIdx && !t.modelIds.includes(modelId) && t.modelIds.length < 4
          ? { ...t, modelIds: [...t.modelIds, modelId] }
          : t,
      ),
    );
  }

  function removeFromTeam(teamIdx: number, modelId: string) {
    setManual((prev) =>
      prev.map((t, i) => (i === teamIdx ? { ...t, modelIds: t.modelIds.filter((id) => id !== modelId) } : t)),
    );
  }

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const judge = judgeModelId === "auto" ? undefined : judgeModelId;
      const body =
        mode === "random"
          ? { rulesetId: selected.id, teamSizes: sizes, seed: seed.trim() || undefined, judgeModelId: judge }
          : {
              rulesetId: selected.id,
              teams: manual.map((t) => ({ name: t.name || undefined, modelIds: t.modelIds })),
              seed: seed.trim() || undefined,
              judgeModelId: judge,
            };
      const res = await fetch("/api/matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { matchId?: string; error?: string };
      if (!res.ok || !data.matchId) throw new Error(data.error ?? "开局失败");
      startTransition(() => router.push(`/arena/${data.matchId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const loading = busy || pendingNav;

  if (rulesets.length === 0) {
    return (
      <p className="panel px-5 py-8 text-[13px] text-fg-faint">
        还没有可用的规则。去 <a className="text-jade underline underline-offset-4" href="/rulesets">规则</a> 写一条。
      </p>
    );
  }

  return (
    <div className="space-y-7">
      {/* ruleset */}
      <section>
        <SectionTitle index="01" title="选规则" hint="规则决定每轮交什么、怎么算赢。" />
        <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {rulesets.map((r) => {
            const active = r.id === rulesetId;
            return (
              <button
                key={r.id}
                onClick={() => setRulesetId(r.id)}
                className={`group rounded-xl border p-4 text-left transition ${
                  active
                    ? "border-jade/50 bg-jade/[0.06]"
                    : "border-line bg-ink-1/60 hover:border-line-strong"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`text-[14px] font-medium ${active ? "text-jade" : "text-fg"}`}>{r.name}</span>
                  <span className="mono text-[10px] text-fg-faint">{r.rounds} 轮</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-fg-dim">{r.tagline}</p>
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {r.slots.map((s) => (
                    <span
                      key={s.key}
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint"
                    >
                      {s.label}
                      {s.reveal === "secret" ? "🔒" : ""}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* roster */}
      <section>
        <SectionTitle
          index="02"
          title="编队"
          hint={`选手池里可用 ${pool.length} 个模型${judgePool.length === 0 ? "（还没有裁判模型，终局裁决会失败）" : ""}`}
        />
        <div className="mb-3 inline-flex rounded-md border border-line bg-ink-1 p-0.5">
          {(["random", "manual"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-3 py-1.5 text-[12px] transition ${
                mode === m ? "bg-ink-3 text-fg" : "text-fg-faint hover:text-fg-dim"
              }`}
            >
              {m === "random" ? "随机抽" : "手动编"}
            </button>
          ))}
        </div>

        {mode === "random" ? (
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p, i) => {
              const enough = pool.length >= p.sizes.reduce((a, b) => a + b, 0);
              return (
                <button
                  key={p.label}
                  disabled={!enough}
                  onClick={() => setPreset(i)}
                  title={enough ? "" : "选手池里的模型不够"}
                  className={`mono rounded-md border px-3 py-1.5 text-[12px] transition ${
                    preset === i
                      ? "border-jade/50 bg-jade/10 text-jade"
                      : "border-line text-fg-dim hover:border-line-strong disabled:opacity-30"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <span className="text-[11px] text-fg-faint">共 {seatCount} 席</span>
          </div>
        ) : (
          <div className="space-y-2.5">
            {manual.map((team, ti) => (
              <div key={ti} className="rounded-lg border border-line bg-ink-1/60 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    value={team.name}
                    onChange={(e) =>
                      setManual((prev) => prev.map((t, i) => (i === ti ? { ...t, name: e.target.value } : t)))
                    }
                    placeholder={`第 ${ti + 1} 方（可留空）`}
                    className="w-40 rounded border border-line bg-ink-0 px-2 py-1 text-[12px] outline-none placeholder:text-fg-faint focus:border-jade/40"
                  />
                  <span className="mono text-[10px] text-fg-faint">{team.modelIds.length}/4</span>
                  {manual.length > 2 && (
                    <button
                      onClick={() => setManual((prev) => prev.filter((_, i) => i !== ti))}
                      className="ml-auto text-[11px] text-fg-faint hover:text-blood"
                    >
                      移除该方
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {team.modelIds.map((id) => {
                    const m = pool.find((x) => x.id === id);
                    return (
                      <button
                        key={id}
                        onClick={() => removeFromTeam(ti, id)}
                        className="mono rounded border border-jade/40 bg-jade/10 px-2 py-0.5 text-[11px] text-jade hover:border-blood/40 hover:text-blood"
                      >
                        {m?.display ?? id} ×
                      </button>
                    );
                  })}
                  <select
                    value=""
                    onChange={(e) => e.target.value && addToTeam(ti, e.target.value)}
                    className="rounded border border-line bg-ink-0 px-2 py-1 text-[11px] text-fg-dim outline-none"
                  >
                    <option value="">+ 添加选手</option>
                    {pool
                      .filter((m) => !team.modelIds.includes(m.id))
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display} · {m.providerName}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            ))}
            <button
              onClick={() => setManual((prev) => [...prev, { name: "", modelIds: [] }])}
              disabled={manual.length >= 8}
              className="rounded border border-dashed border-line px-3 py-1.5 text-[12px] text-fg-faint transition hover:border-line-strong hover:text-fg-dim disabled:opacity-40"
            >
              + 加一方
            </button>
          </div>
        )}
      </section>

      {/* judge */}
      <section>
        <SectionTitle
          index="03"
          title="定裁判"
          hint="默认自动：优先挑与选手不同接入方的裁判。指定的裁判在开局那一刻冻结，之后改配置影响不到这一局。"
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="裁判模型"
            value={judgeModelId}
            onChange={(e) => pickJudge(e.target.value)}
            className="min-w-64 rounded-md border border-line bg-ink-1 px-3 py-2 text-[12px] text-fg-dim outline-none focus:border-jade/40"
          >
            <option value="auto">自动 · 优先挑与选手不同接入方</option>
            {judgeGroups.map(([providerId, group]) => (
              <optgroup key={providerId} label={group.providerName}>
                {group.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="text-[11px] text-fg-faint">
            裁判读到的只有提交内容与 A / B / C 字母：思考、模型名、队名都不进 prompt。
          </span>
        </div>
        {judgePool.length === 0 && (
          <p className="mt-2 text-[12px] text-amber/90">
            还没有可用的裁判模型：去{" "}
            <a className="underline underline-offset-4" href="/setups">
              配置页
            </a>{" "}
            给某个模型打开「裁判」。
          </p>
        )}
        {clashSeats > 0 && chosenJudge && (
          <p className="mt-2 text-[12px] text-amber/90">
            「{chosenJudge.display}」与 {clashSeats} 位选手同属「{chosenJudge.providerName}」，判分可能带自偏好。
          </p>
        )}
      </section>

      {/* start */}
      <section className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <button
          onClick={start}
          disabled={!canStart || loading}
          className="inline-flex items-center gap-2 rounded-lg bg-jade px-6 py-3 text-[15px] font-medium text-ink-0 transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "开局中…" : "开打"}
          <span className="text-[13px] opacity-60">→</span>
        </button>
        <input
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="种子（可留空）"
          className="mono w-52 rounded-md border border-line bg-ink-1 px-3 py-2.5 text-[12px] outline-none placeholder:text-fg-faint focus:border-jade/40"
        />
        {!canStart && (
          <span className="text-[12px] text-amber/90">
            {pool.length < 2
              ? "选手池里至少要有两个可用模型——去配置页填 Key 并拉取模型。"
              : "每一方至少要有一个模型。"}
          </span>
        )}
        {error && <span className="text-[12px] text-blood">{error}</span>}
      </section>
    </div>
  );
}

function SectionTitle({ index, title, hint }: { index: string; title: string; hint: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-3">
      <span className="mono text-[10px] text-fg-faint">{index}</span>
      <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
      <span className="text-[11px] text-fg-faint">{hint}</span>
    </div>
  );
}
