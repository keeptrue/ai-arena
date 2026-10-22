"use client";

import { useEffect, useMemo, useState } from "react";

interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  enabled: boolean;
}
type ReasoningOption =
  | { type: "effort"; values: string[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min?: number; max?: number };

interface ModelCard {
  key: string;
  name: string;
  reasoning: boolean;
  options: ReasoningOption[];
  contextWindow: number | null;
  outputLimit: number | null;
}

interface Model {
  id: string;
  providerId: string;
  providerName: string;
  providerKind: string;
  modelId: string;
  display: string;
  temperature: number;
  supportsReasoning: boolean;
  reasoningEffort: string | null;
  thinkingBudget: number | null;
  reasoningStyle: string | null;
  card: ModelCard | null;
  inContenderPool: boolean;
  inJudgePool: boolean;
  enabled: boolean;
  contextWindow: number | null;
}
interface Bootstrap {
  providers: Provider[];
  models: Model[];
  secrets: Record<string, string>;
}

const KINDS = ["openai", "anthropic", "gemini", "mock"] as const;

const EFFORT_LABEL: Record<string, string> = {
  none: "关",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};
const FALLBACK_EFFORTS = ["low", "medium", "high"];

export function SetupEditor() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", kind: "openai", baseUrl: "", apiKey: "" });

  async function reload() {
    const res = await fetch("/api/bootstrap", { cache: "no-store" });
    setData((await res.json()) as Bootstrap);
  }

  useEffect(() => {
    void reload();
  }, []);

  function flash(tone: "ok" | "err", text: string) {
    setNotice({ tone, text });
    setTimeout(() => setNotice(null), 4000);
  }

  async function saveKey(provider: Provider) {
    const apiKey = (keys[provider.id] ?? "").trim();
    if (!apiKey) return;
    setSaving(provider.id);
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...provider, apiKey }),
      });
      const json = (await res.json()) as { hasKey?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "保存失败");
      if (!json.hasKey) throw new Error("服务端没有确认写入");
      setKeys((k) => ({ ...k, [provider.id]: "" }));
      flash("ok", `${provider.name} 的 Key 已写入 data/secrets.json`);
      void reload();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function pullModels(provider: Provider) {
    setSyncing(provider.id);
    try {
      const res = await fetch(`/api/providers/${provider.id}/models`, { method: "POST" });
      const json = (await res.json()) as { count?: number; enriched?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "拉取失败");
      flash(
        "ok",
        `${provider.name} 拉回 ${json.count} 个模型${
          json.enriched ? `，其中 ${json.enriched} 个按 models.dev 补齐了思考能力` : ""
        }`,
      );
      void reload();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
    }
  }

  async function removeProvider(provider: Provider) {
    await fetch(`/api/providers/${provider.id}`, { method: "DELETE" });
    flash("ok", `已删除 ${provider.name}`);
    void reload();
  }

  async function createProvider() {
    if (!draft.name.trim() || !draft.baseUrl.trim()) return;
    const res = await fetch("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) return flash("err", json.error ?? "创建失败");
    setCreating(false);
    setDraft({ name: "", kind: "openai", baseUrl: "", apiKey: "" });
    flash("ok", "接入方已创建，接着点「拉取模型」");
    void reload();
  }

  async function patchModel(id: string, patch: Record<string, unknown>) {
    const res = await fetch("/api/models", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    const json = (await res.json()) as { models?: Model[]; error?: string };
    if (json.models && data) setData({ ...data, models: json.models });
    if (!res.ok && json.error) flash("err", json.error);
  }

  /** models.dev is the source of truth for which reasoning knobs a model exposes. */
  async function calibrateModel(model: Model) {
    setCalibrating(model.id);
    try {
      const res = await fetch("/api/models", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: model.id, calibrate: true }),
      });
      const json = (await res.json()) as { models?: Model[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? "校准失败");
      const updated = json.models?.find((m) => m.id === model.id);
      if (json.models && data) setData({ ...data, models: json.models });
      flash("ok", `${model.display} 已按 models.dev 校准${updated?.supportsReasoning ? " · 支持思考" : " · 无思考通道"}`);
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setCalibrating(null);
    }
  }

  async function calibrateProvider(providerId: string, models: Model[]) {
    setCalibrating(providerId);
    try {
      let ok = 0;
      let miss = 0;
      for (const m of models) {
        const res = await fetch("/api/models", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: m.id, calibrate: true }),
        });
        if (res.ok) ok += 1;
        else miss += 1;
      }
      flash("ok", `校准完成：${ok} 个命中 models.dev${miss ? `，${miss} 个无条目` : ""}`);
      void reload();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setCalibrating(null);
    }
  }

  const grouped = useMemo(() => {
    if (!data) return [];
    return data.providers.map((p) => ({
      provider: p,
      models: data.models.filter((m) => m.providerId === p.id),
    }));
  }, [data]);

  if (!data) return <p className="py-10 text-[13px] text-fg-faint">读取配置中…</p>;

  const contenderCount = data.models.filter((m) => m.enabled && m.inContenderPool).length;
  const judgeCount = data.models.filter((m) => m.enabled && m.inJudgePool).length;

  return (
    <div className="space-y-10">
      {notice && (
        <div
          className={`rounded-md border px-3 py-2 text-[12px] ${
            notice.tone === "ok" ? "border-jade/30 bg-jade/10 text-jade" : "border-blood/30 bg-blood/10 text-blood"
          }`}
        >
          {notice.text}
        </div>
      )}

      <section>
        <SectionHead
          title="接入方"
          hint="名称、类型、base URL、Key 都可以自己填。Key 存在 data/secrets.json（0600），不入库、不进 git。"
          action={
            <button
              onClick={() => setCreating((v) => !v)}
              className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg"
            >
              {creating ? "取消" : "+ 新增接入方"}
            </button>
          }
        />

        {creating && (
          <div className="panel mb-3 flex flex-wrap items-end gap-2 p-3">
            <Field label="名称">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="例如 我的中转站"
                className="w-40 rounded border border-line bg-ink-1 px-2 py-1.5 text-[12px] outline-none focus:border-jade/40"
              />
            </Field>
            <Field label="类型">
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                className="rounded border border-line bg-ink-1 px-2 py-1.5 text-[12px] outline-none"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="base URL">
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
                className="mono w-64 rounded border border-line bg-ink-1 px-2 py-1.5 text-[11px] outline-none focus:border-jade/40"
              />
            </Field>
            <Field label="Key">
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="sk-…"
                className="mono w-40 rounded border border-line bg-ink-1 px-2 py-1.5 text-[11px] outline-none focus:border-jade/40"
              />
            </Field>
            <button
              onClick={createProvider}
              className="rounded-md border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade"
            >
              创建
            </button>
          </div>
        )}

        <div className="panel divide-y divide-line">
          {data.providers.map((p) => {
            const masked = data.secrets[p.id];
            const isMock = p.kind === "mock";
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="w-36 shrink-0">
                  <div className="truncate text-[13px] text-fg">{p.name}</div>
                  <div className="mono text-[10px] text-fg-faint">{p.kind}</div>
                </div>
                <div className="mono min-w-0 flex-1 truncate text-[11px] text-fg-faint">{p.baseUrl}</div>
                <div className="mono w-32 shrink-0 text-[11px]">
                  {isMock ? (
                    <span className="text-jade">本地 · 无需 Key</span>
                  ) : masked ? (
                    <span className="text-jade">已配置 {masked}</span>
                  ) : (
                    <span className="text-amber">未配置</span>
                  )}
                </div>
                {!isMock && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      value={keys[p.id] ?? ""}
                      onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                      placeholder="粘贴 Key"
                      className="mono w-44 rounded border border-line bg-ink-1 px-2 py-1 text-[11px] outline-none placeholder:text-fg-faint focus:border-jade/40"
                    />
                    <button
                      onClick={() => saveKey(p)}
                      disabled={saving === p.id || !(keys[p.id] ?? "").trim()}
                      className="rounded border border-line px-2 py-1 text-[11px] text-fg-dim transition hover:border-jade/40 hover:text-jade disabled:opacity-40"
                    >
                      保存
                    </button>
                  </div>
                )}
                <button
                  onClick={() => pullModels(p)}
                  disabled={syncing === p.id || (!isMock && !masked)}
                  className="rounded border border-line px-2.5 py-1 text-[11px] text-fg-dim transition hover:border-jade/40 hover:text-jade disabled:opacity-40"
                >
                  {syncing === p.id ? "拉取中…" : "拉取模型"}
                </button>
                <button
                  onClick={() => removeProvider(p)}
                  className="text-[11px] text-fg-faint transition hover:text-blood"
                >
                  删除
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHead
          title="模型池"
          hint={`选手池 ${contenderCount} 个，裁判池 ${judgeCount} 个。随机配对只从选手池取；开局页可以从裁判池里指定裁判，默认自动优先挑与选手不同接入方的。思考强度按模型单独配置，来源是 models.dev 的能力目录。`}
        />
        <div className="space-y-3">
          {grouped.map(({ provider, models }) =>
            models.length === 0 ? null : (
              <div key={provider.id} className="panel overflow-hidden">
                <div className="flex items-center gap-2 border-b border-line px-4 py-2">
                  <span className="text-[12px] text-fg-dim">{provider.name}</span>
                  <span className="mono text-[10px] text-fg-faint">{models.length} 个</span>
                  <button
                    onClick={() => calibrateProvider(provider.id, models)}
                    disabled={calibrating === provider.id || provider.kind === "mock"}
                    title="按 models.dev 补齐思考能力与可选的思考强度"
                    className="mono ml-auto rounded border border-line px-2 py-0.5 text-[10px] text-fg-faint transition hover:border-jade/40 hover:text-jade disabled:opacity-40"
                  >
                    {calibrating === provider.id ? "校准中…" : "按 models.dev 校准"}
                  </button>
                </div>
                <div className="divide-y divide-line/70">
                  {models.map((m) => (
                    <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-[12px] ${m.enabled ? "text-fg" : "text-fg-faint line-through"}`}>
                          {m.display}
                        </div>
                        <div className="mono truncate text-[10px] text-fg-faint">
                          {m.modelId}
                          {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}
                        </div>
                      </div>
                      <ReasoningControls
                        model={m}
                        busy={calibrating === m.id}
                        onPatch={(patch) => patchModel(m.id, patch)}
                        onCalibrate={() => calibrateModel(m)}
                      />
                      <Toggle
                        on={m.inContenderPool}
                        label="选手"
                        onClick={() => patchModel(m.id, { inContenderPool: !m.inContenderPool })}
                      />
                      <Toggle
                        on={m.inJudgePool}
                        label="裁判"
                        onClick={() => patchModel(m.id, { inJudgePool: !m.inJudgePool })}
                      />
                      <Toggle
                        on={m.enabled}
                        label="启用"
                        onClick={() => patchModel(m.id, { enabled: !m.enabled })}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ),
          )}
          {data.models.length === 0 && (
            <p className="panel px-4 py-8 text-center text-[13px] text-fg-faint">
              还没有模型。给接入方填 Key，然后点「拉取模型」。
            </p>
          )}
        </div>
      </section>

    </div>
  );
}

/** Per-model reasoning strength: effort ladder, explicit token budget, or a plain toggle. */
function ReasoningControls({
  model,
  busy,
  onPatch,
  onCalibrate,
}: {
  model: Model;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onCalibrate: () => void;
}) {
  const effortOption = model.card?.options.find(
    (o): o is Extract<ReasoningOption, { type: "effort" }> => o.type === "effort",
  );
  const levels = effortOption?.values.length ? effortOption.values : FALLBACK_EFFORTS;
  const supports = model.supportsReasoning || !!model.card?.reasoning;
  const wantsBudget = model.providerKind === "anthropic" || model.providerKind === "gemini";
  const budgetRange = model.card?.options.find(
    (o): o is Extract<ReasoningOption, { type: "budget_tokens" }> => o.type === "budget_tokens",
  );

  return (
    <div className="flex items-center gap-1.5">
      <Toggle
        on={model.supportsReasoning}
        label="思考"
        onClick={() => onPatch({ supportsReasoning: !model.supportsReasoning })}
      />
      {supports && (
        <label className="flex items-center gap-1">
          <span className="sr-only">思考强度</span>
          <select
            value={model.reasoningEffort ?? ""}
            onChange={(e) => onPatch({ reasoningEffort: e.target.value || null })}
            className="rounded border border-line bg-ink-1 px-1.5 py-1 text-[11px] text-fg-dim outline-none focus:border-jade/40"
          >
            <option value="">默认</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {EFFORT_LABEL[level] ?? level}
              </option>
            ))}
          </select>
        </label>
      )}
      {supports && wantsBudget && (
        <input
          key={`${model.id}-${model.thinkingBudget ?? "auto"}`}
          type="number"
          defaultValue={model.thinkingBudget ?? ""}
          min={budgetRange?.min ?? 0}
          max={budgetRange?.max}
          placeholder="预算"
          title="显式思考预算（tokens）；留空则按强度换算"
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next = raw === "" ? null : Number(raw);
            if (next === model.thinkingBudget) return;
            onPatch({ thinkingBudget: next });
          }}
          className="mono w-16 rounded border border-line bg-ink-1 px-1.5 py-1 text-[11px] outline-none placeholder:text-fg-faint focus:border-jade/40"
        />
      )}
      <button
        onClick={onCalibrate}
        disabled={busy || model.providerKind === "mock"}
        title="从 models.dev 读取这个模型的思考能力"
        className="rounded border border-line px-2 py-1 text-[11px] text-fg-faint transition hover:border-jade/40 hover:text-jade disabled:opacity-40"
      >
        {busy ? "校准中…" : "校准"}
      </button>
    </div>
  );
}

function SectionHead({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
        <p className="mt-1 max-w-[80ch] text-[12px] text-fg-faint">{hint}</p>
      </div>
      {action}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded border px-2 py-1 text-[11px] transition ${
        on ? "border-jade/40 bg-jade/10 text-jade" : "border-line text-fg-faint hover:border-line-strong"
      }`}
    >
      {label}
    </button>
  );
}
