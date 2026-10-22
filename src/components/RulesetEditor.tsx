"use client";

import { useState } from "react";

export interface RulesetItem {
  id: string;
  slug: string;
  name: string;
  sourceMd: string;
  blueprint: any;
}

const TEMPLATE = `# 新的对局

一句话说清这是什么局。

## 局面

- 每轮所有方**同时**提交什么。
- 哪些东西公开，哪些是暗牌。
- 一共几轮。

## 怎么算赢

主持方按哪几个维度判定，每个维度看什么。

## 你可以做的事

允许撒谎、结盟、翻脸……把允许的边界写清楚。
`;

export function RulesetEditor({ initial }: { initial: RulesetItem[] }) {
  const [items, setItems] = useState<RulesetItem[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [sourceMd, setSourceMd] = useState(initial[0]?.sourceMd ?? TEMPLATE);
  const [blueprint, setBlueprint] = useState<any>(initial[0]?.blueprint ?? null);
  const [blueprintText, setBlueprintText] = useState(
    initial[0]?.blueprint ? JSON.stringify(initial[0].blueprint, null, 2) : "",
  );
  const [busy, setBusy] = useState<"compile" | "save" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function select(item: RulesetItem) {
    setSelectedId(item.id);
    setSourceMd(item.sourceMd);
    setBlueprint(item.blueprint);
    setBlueprintText(JSON.stringify(item.blueprint, null, 2));
    setMessage(null);
  }

  function newRule() {
    setSelectedId(null);
    setSourceMd(TEMPLATE);
    setBlueprint(null);
    setBlueprintText("");
    setMessage(null);
  }

  async function compile() {
    setBusy("compile");
    setMessage(null);
    try {
      const res = await fetch("/api/rulesets/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceMd }),
      });
      const data = (await res.json()) as { blueprint?: any; error?: string; warnings?: string[]; compiler?: string };
      if (!res.ok || !data.blueprint) throw new Error(data.error ?? "编译失败");
      setBlueprint(data.blueprint);
      setBlueprintText(JSON.stringify(data.blueprint, null, 2));
      setMessage({
        tone: "ok",
        text: `编译完成（${data.compiler}）${data.warnings?.length ? ` · ${data.warnings.join("；")}` : ""}`,
      });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!blueprint) return;
    setBusy("save");
    setMessage(null);
    try {
      const parsed = JSON.parse(blueprintText || "{}");
      const res = await fetch("/api/rulesets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: parsed.id,
          name: parsed.name,
          sourceMd,
          blueprint: parsed,
        }),
      });
      const data = (await res.json()) as { rulesets?: any[]; error?: string; issues?: string[] };
      if (!res.ok) throw new Error(`${data.error ?? "保存失败"}${data.issues?.length ? `：${data.issues.join("；")}` : ""}`);
      const list = (data.rulesets ?? []).map((r: any) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        sourceMd: r.sourceMd,
        blueprint: r.blueprint,
      }));
      setItems(list);
      const saved = list.find((r: RulesetItem) => r.blueprint?.id === parsed.id);
      if (saved) setSelectedId(saved.id);
      setBlueprint(parsed);
      setMessage({ tone: "ok", text: "已保存，可以直接拿去开局" });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr_1fr]">
      <aside className="panel h-fit p-2">
        <button
          onClick={newRule}
          className="mb-2 w-full rounded-md border border-dashed border-line px-2 py-1.5 text-[12px] text-fg-faint transition hover:border-line-strong hover:text-fg-dim"
        >
          + 新建规则
        </button>
        <ul className="space-y-0.5">
          {items.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => select(r)}
                className={`w-full rounded px-2 py-1.5 text-left text-[12px] transition ${
                  selectedId === r.id ? "bg-ink-3 text-fg" : "text-fg-dim hover:bg-ink-2"
                }`}
              >
                <span className="block truncate">{r.name}</span>
                <span className="mono block truncate text-[10px] text-fg-faint">{r.slug}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="label">规则正文（自然语言）</span>
          <button
            onClick={compile}
            disabled={busy !== null || sourceMd.trim().length < 20}
            className="rounded-md border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade transition hover:bg-jade/15 disabled:opacity-40"
          >
            {busy === "compile" ? "编译中…" : "编译成蓝图"}
          </button>
        </div>
        <textarea
          value={sourceMd}
          onChange={(e) => setSourceMd(e.target.value)}
          spellCheck={false}
          className="mono h-[520px] w-full resize-none rounded-lg border border-line bg-ink-1 p-3 text-[12px] leading-relaxed text-fg outline-none focus:border-jade/40"
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="label">对局蓝图</span>
          <button
            onClick={save}
            disabled={busy !== null || !blueprintText.trim()}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg disabled:opacity-40"
          >
            {busy === "save" ? "保存中…" : "保存"}
          </button>
        </div>

        {blueprint && (
          <div className="panel space-y-2 p-3 text-[12px]">
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-medium">{blueprint.name}</span>
              <span className="mono text-[10px] text-fg-faint">{blueprint.rounds} 轮</span>
            </div>
            <p className="text-fg-dim">{blueprint.tagline}</p>
            <div className="flex flex-wrap gap-1">
              {(blueprint.submission?.slots ?? []).map((s: any) => (
                <span key={s.key} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint">
                  {s.label} · {s.type}
                  {s.reveal === "secret" ? " 🔒" : ""}
                </span>
              ))}
            </div>
            <div className="space-y-0.5">
              {(blueprint.rubric?.dimensions ?? []).map((d: any) => (
                <div key={d.key} className="flex items-baseline gap-2 text-[11px]">
                  <span className="w-16 shrink-0 text-fg-dim">{d.label}</span>
                  <span className="mono text-fg-faint">{Math.round(d.weight * 100)}%</span>
                  <span className="truncate text-fg-faint">{d.hint}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <textarea
          value={blueprintText}
          onChange={(e) => setBlueprintText(e.target.value)}
          spellCheck={false}
          placeholder="编译后这里会出现结构化蓝图。也可以手写或直接改。"
          className="mono h-[380px] w-full resize-none rounded-lg border border-line bg-ink-1 p-3 text-[11px] leading-relaxed text-fg-dim outline-none focus:border-jade/40"
        />
      </section>

      {message && (
        <p
          className={`lg:col-span-3 rounded-md border px-3 py-2 text-[12px] ${
            message.tone === "ok"
              ? "border-jade/30 bg-jade/10 text-jade"
              : "border-blood/30 bg-blood/10 text-blood"
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
